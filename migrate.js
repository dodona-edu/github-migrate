#!/usr/bin/env node

const axios = require("axios");
const fs = require("fs");
const yaml = require("js-yaml");
const program = require("commander");
const util = require("util");
const childProcess = require("child_process");
const colors = require("colors");

/**
 * Execute in shell, while connecting stdin, stdout and stderr to that of
 * the current process
 */
function sh(commandline, options) {
  console.log(commandline);
  return childProcess.execSync(commandline, {stdio: "inherit", ...options});
}

function warn(message) {
  const date = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${date}] ${message}`.red);
}

function log(message) {
  const date = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${date}] ${message}`.blue.bold);
}

function progress(message) {
  const date = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${date}] ${message}`.blue);
}

function writeJson(path, object) {
  fs.writeFileSync(path, JSON.stringify(object, null, 2));
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path));
}

program.version("0.1.0")
  .option("-c, --config <path>",
          "Configuration file path. Defaults to ./config.yml")
  .option("-s, --source <repo>",
          "Source repository, overrides the source in the configuration")
  .option("-d, --destination <repo>",
          "Destination repository, overrides the destination in the configuration")
  .option("-r, --reset",
          "Deletes and recreate the destination repository. Use with caution!")
  .option("-o, --overwrite",
          "Overwrites steps if a file already exists instead of resuming.")
  .parse(process.argv);

const configFile = program.config || "./config.yml";
const config = yaml.safeLoad(fs.readFileSync(configFile));

config.destination.admin_token = config.destination.admin_token || config.destination.default_token;

config.source.repository = program.source || config.source.repository;
config.destination.repository = program.source || config.destination.repository;

const sourceInfo = parseRepoUrl(config.source.repository);
const destInfo = parseRepoUrl(config.destination.repository);

config.source = {
  url: `${config.source.api}/repos/${sourceInfo.owner}/${sourceInfo.reponame}`,
  ...config.source,
  ...sourceInfo,
};

config.destination = {
  url: `${config.destination.api}/repos/${destInfo.owner}/${destInfo.reponame}`,
  ...config.destination,
  ...destInfo,
};

const repoDir = "data/" + config.source.reponame;
fs.mkdirSync(repoDir, {recursive: true});

const cloneDir = repoDir + "/clone";
const mirrorDir = repoDir + "/mirror.git";
const issuePath = repoDir + "/issues.json";
const labelPath = repoDir + "/labels.json";
const commentPath = repoDir + "/comments.json";
const missingPath = repoDir + "/missing.json";
const mentionsPath = repoDir + "/mentions.json";
const creatorsPath = repoDir + "/creators.json";

function assert(assertion, message) {
  if (!assertion) throw (message || "AssertionError");
}

async function invoke(method, url, data, token) {
  try {
    return await axios({
      method: method,
      url: url,
      data: data,
      headers: {
        "Authorization": "token " + (token || config.source.token),
        "User-Agent": "node.js",
      },
    });
  } catch (e) {
    const response = e.response;
    if (response.status === 403 &&
        response.headers["x-ratelimit-remaining"] == 0) {
      warn("Ratelimit encountered, retrying in 1 second");
      sh("sleep 1");
      return await invoke(method, url, data, token);
    } else {
      throw e;
    }
  }
}

function get(url, token) {
  return invoke("get", url, null, token);
}

function destroy(url, token) {
  return invoke("delete", url, null, token);
}

function patch(url, data, token) {
  return invoke("patch", url, data, token);
}

function post(url, data, token) {
  return invoke("post", url, data, token);
}

function put(url, data, token) {
  return invoke("put", url, data, token);
}

/**
 * Call and await the given callback with an increasing integer while
 * collecting the result in an array. Continues until the callback returns
 * null.
 */
async function collectUntilNull(callback) {
  let i = 1;
  const collector = [];
  let result = await callback(i);
  while (result) {
    i += 1;
    collector.push(result);
    result = await callback(i);
  }
  return collector;
}

async function fetchIssue(issueNumber) {
  progress(`Fetching issue ${issueNumber}`);
  try {
    const request = await get(`${config.source.url}/issues/${issueNumber}`);

    const issue = request.data;
    if (issue.pull_request) {
      const pull = (await get(`${config.source.url}/pulls/${issueNumber}`)).data;
      issue.base = pull.base;
      issue.head = pull.head;

      const events = (await get(issue.events_url)).data;
      issue.merged = events.some(e => e.event === "merged");
    }

    return issue;
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return null;
    }
    throw e;
  }
}

async function fetchAllIssues() {
  log("Fetching issues");
  const issues = (await collectUntilNull(fetchIssue))
    .sort((a, b) => a.number - b.number);
  writeJson(issuePath, issues);
  return issues;
}

async function fetchLabels(page) {
  const response = await get(`${config.source.url}/labels?` +
                             `page=${page}&per_page=100`);
  if (response.data.length === 0) {
    return null;
  }
  return response.data;
}

async function fetchAllLabels() {
  log("Fetching labels");
  const labels = [].concat(...(await collectUntilNull(fetchLabels)));
  writeJson(labelPath, labels);
  return labels;
}

async function fetchCommentPage(type, page) {
  const response = await get(`${config.source.url}/${type}?` +
                             `page=${page}&state=all&per_page=100`);
  if (response.data.length === 0) {
    return null;
  }
  return response.data;
}

async function fetchCommentsOfType(type) {
  progress(`Fetching ${type}`);
  return collectUntilNull(async i => await fetchCommentPage(type, i));
}

async function fetchAllComments() {
  log("Fetching comments");
  const pullComments = await fetchCommentsOfType("pulls/comments");
  const issueComments = await fetchCommentsOfType("issues/comments");
  const commitComments = await fetchCommentsOfType("comments");
  const comments = []
    .concat(...pullComments)
    .concat(...issueComments)
    .concat(...commitComments)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  writeJson(commentPath, comments);
  return comments;
}

function parseRepoUrl(cloneUrl) {
  const matchSsh = /^git@([^:]+):([^/]+)\/(.+)\.git$/.exec(cloneUrl);
  if (matchSsh) {
    return {remote: matchSsh[1], owner: matchSsh[2], reponame: matchSsh[3]};
  }
  const matchHttp = /^https?:\/\/([^/]+)\/([^/]+)\/(.+)\.git$/.exec(cloneUrl);
  if (matchHttp) {
    return {remote: matchHttp[1], owner: matchHttp[2], reponame: matchHttp[3]};
  }
  throw `Repository '${cloneUrl}' is not in ssh or https format.`;
}

function moveRepository() {
  log("Mirroring repository");
  if (checkIfNeeded(mirrorDir)) {
    progress("Creating mirror from source");
    sh(`git clone --mirror ${config.source.repository} ${mirrorDir}`);
    sh(`git -C ${mirrorDir} remote set-url origin ${config.destination.repository}`);
    sh(`git -C ${mirrorDir} remote set-url --push origin ${config.destination.repository}`);
    progress("Replacing packed-refs");
    sh(`sed -i.bak 's_ refs/pull/_ refs/pr/_' ${mirrorDir}/packed-refs`);
  }
  progress("Pushing to destination");
  sh(`git -C ${mirrorDir} push --mirror ${config.destination.repository}`);

  if (checkIfNeeded(cloneDir)) {
    progress("Creating clone from destination");
    sh(`git clone ${config.destination.repository} ${cloneDir}`);
  }
}

async function commitExists(sha) {
  const url = `${config.destination.url}/git/commits/${sha}`;
  try {
    await get(url, config.destination.default_token);
    return true;
  } catch (e) {
    if (e.response.status == 404) {
      return false;
    } else {
      throw e;
    }
  }
}

async function missingCommits(items) {
  const commits = items
    .map(item => {
      if (item.base) { // Pull Request
        return {url: item.html_url, sha: item.base.sha};
      } else if (item.pull_request_url) { // Review comment
        return {url: item.html_url, sha: item.original_commit_id};
      } else if (item.commit_id) { // Commit comment
        return {url: item.html_url, sha: item.commit_id};
      }
    })
    .filter(item => item !== undefined);

  const checked = new Set();
  const missing = [];
  for (let commit of commits) {
    if (!checked.has(commit.sha)) {
      checked.add(commit.sha);
      let exists = await commitExists(commit.sha);
      if (!exists) {
        missing.push(commit);
      }
    }
  }

  writeJson(missingPath, missing);
  return missing;
}

async function createBranch(branchname, sha) {
  progress(`Creating branch ${branchname}`);
  try {
    const response = await post(`${config.destination.url}/git/refs`,
                                {
                                  "ref": `refs/heads/${branchname}`,
                                  "sha": sha,
                                },
                                config.destination.default_token);
  } catch (e) {
    if (e.response.data.message === "Reference already exists") {
      warn(`Branch #${branchname} already exists. Ignoring...`);
    } else {
      throw e;
    }
  }
}

function formatDate(date) {
  const items = new Date(date).toString().split(" ");
  const day = items.slice(0, 4).join(" ");
  const time = items[4].split(":").slice(0, 2).join(":");
  return `${day} at ${time}`;
}

function authorToken(srcUser) {
  const token = config.destination.tokens[srcUser];
  if (!token) {
    warn(`Missing token for ${srcUser}, using default token`);
  }
  if (srcUser === "rbmaerte") { // TODO: turn on for all users
    return token || config.destination.default_token;
  } else {
    return config.destination.default_token;
  }
}

function author(srcUser) {
  const user = config.destination.usernames[srcUser];
  return user ? `\`@${user}\`` : srcUser; // TODO: actually mention
}

function suffix(item) {
  let type;
  if (item.pull_request) {
    type = "pull request";
  } else if (item.labels) {
    type = "issue";
  } else {
    type = "comment";
  }

  let suffix = `_[Original ${type}](${item.html_url})`;
  suffix += ` by ${author(item.user.login)}`;
  suffix += ` on ${formatDate(item.created_at)}._`;
  if (item.closed_at) {
    suffix += `\n_${item.merged ? "Merged" : "Closed"} `;
    if (item.closed_by) {
      suffix += ` by ${author(item.closed_by.login)}`;
    }
    suffix += ` on ${formatDate(item.closed_at)}._`;
  }
  return suffix;
}

function branchNames(pull) {
  return {
    head: `migrated/pr-${pull.number}/${pull.head.ref}`,
    base: `migrated/pr-${pull.number}/${pull.base.ref}`,
  };
}

async function createPullRequest(pull) {
  progress(`Creating PR #${pull.number}`);

  let head, base;
  if (pull.state == "open") {
    head = pull.head.ref;
    base = pull.base.ref;
  } else {
    ({head, base} = branchNames(pull));
    await createBranch(head, pull.head.sha);
    await createBranch(base, pull.base.sha);
  }

  try {
    await post(`${config.destination.url}/pulls`,
               {
                 title: pull.title,
                 body: `${pull.body}\r\n\r\n${suffix(pull)}`,
                 head: head,
                 base: base,
               },
               authorToken(pull.user.login));
  } catch (e) {
    if (e.response.status == 422) {
      console.dir(e.response.data);
      if (e.response.data.message === "Reference update failed") {
        warn("Branch creation failed somehow. Retrying ...");
        sh("sleep 1");
      } else if (e.response.data.errors[0].message.startsWith("No commits between ")) {
        warn(`Trying to fix PR #${pull.number}`);
        sh(`git -C ${cloneDir} pull`);
        await createBrokenPullRequest(pull);
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }
}

async function createBrokenPullRequest(pull) {
  progress(`Creating dummy branches for PR #${pull.number}`);

  const {head, base} = branchNames(pull);

  sh(`git -C ${cloneDir} checkout master`);
  sh(`git -C ${cloneDir} checkout -B ${base}`);
  sh(`git -C ${cloneDir} push ${config.destination.repository} ${base}`);

  sh(`git -C ${cloneDir} checkout -B ${head}`);
  sh(`git -C ${cloneDir} commit --allow-empty --message "Dummy commit for PR #${pull.number}"`);
  sh(`git -C ${cloneDir} push ${config.destination.repository} ${head}`);

  sh(`git -C ${cloneDir} checkout master`);

  progress(`Creating broken PR #${pull.number}`);
  const notice = `_**Note:** the base commit (${pull.base.sha}) is lost,` +
    " so unfortunately we cannot show you the changes added by this PR._";
  await post(`${config.destination.url}/pulls`,
             {
               title: pull.title,
               body: `${pull.body}\r\n\r\n${suffix(pull)}\r\n\r\n${notice}\r\n\r\n`,
               head: head,
               base: base,
             },
             authorToken(pull.user.login));
}

async function createIssue(issue) {
  progress(`Creating issue #${issue.number}`);
  await post(`${config.destination.url}/issues`,
             {
               title: issue.title,
               body: `${issue.body}\r\n\r\n${suffix(issue)}`,
             },
             authorToken(issue.user.login));
}

async function createIssuesAndPulls(issues, missing) {
  log("Creating issues and pull requests");
  const missingHashes = new Set(missing.map(c => c.sha));
  for (let issue of issues) {
    if (issue.pull_request) {
      if (missingHashes.has(issue.base.sha)) {
        await createBrokenPullRequest(issue);
      } else {
        await createPullRequest(issue);
      }
    } else {
      await createIssue(issue);
    }
  }
}


async function findCreators(items) {
  log("Searching for creator usernames");
  const creatorSet = new Set(items.map(item => item.user.login));
  const creators = Array.from(creatorSet);
  writeJson(creatorsPath, creators);
  return creators;
}

async function filterMentions(items) {
  log("Filtering mentioned usernames");
  const regex = /@[-A-z0-9]{1,39}/;
  const mentions = new Map();
  for (let item of items) {
    const body = item.body;

    const parts = [];

    let last = 0;
    let match = regex.exec(body);
    while (match) {
      parts.push(body.slice(last, last + match.index));
      let username = match[0].slice(1);

      if (!mentions.has(username)) {
        try {
          const response = await get(`${config.source.api}/users/${username}`);
          const user = response.data;
          mentions.set(username, user.email);
        } catch (e) {
          // ignore, user does not exist
        }
      }

      let newName = config.destination.usernames[username];
      if (newName) {
        // TODO: actually mention user
        parts.push(`\`@${newName}\``);
      } else {
        parts.push(`\`@${username}\``);
      }
      last += match.index + match[0].length;
      match = regex.exec(body.slice(last));
    }
    parts.push(body.slice(last));
    item.body = parts.join("");
  }

  writeJson(mentionsPath, Array.from(mentions));
  return mentions;
}

function checkIfNeeded(path) {
  if (fs.existsSync(path)) {
    if (program.overwrite) {
      sh(`rm -rf ${path}`);
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Reset the destination repository by deleting and recreating it. This needs
 * the 'delete_repositories' scope. Use with caution.
 */
async function resetDestination() {
  progress("Deleting destination repository");
  await destroy(config.destination.url, config.destination.admin_token);
  progress("Creating destination repository");
  await post(`${config.destination.api}/orgs/${config.destination.owner}/repos`,
             {name: config.destination.reponame, private: true},
             config.destination.admin_token);
}

async function createPullComment(comment) {
  const pullNumber = comment.pull_request_url.split("/").pop();
  progress(`Creating review comment for PR #${pullNumber} (${comment.id})`);
  try {
    await post(`${config.destination.url}/pulls/${pullNumber}/comments`,
               {
                 body: `${comment.body}\r\n\r\n${suffix(comment)}`,
                 commit_id: comment.original_commit_id,
                 path: comment.path,
                 position: comment.original_position,
               },
               authorToken(comment.user.login));
  } catch (e) {
    if (e.response.status == 422 &&
        e.response.data.errors[0].message.endsWith("is not part of the pull request")) {
      warn("Ignoring review comment because the original commit is gone. (This is normal)");
    } else {
      throw e;
    }
  }
}

async function createCommitComment(comment) {
  progress(`Creating commit comment for ${comment.commit_id} (${comment.id})`);
  await post(`${config.destination.url}/commits/${comment.commit_id}/comments`,
             {
               body: `${comment.body}\r\n\r\n${suffix(comment)}`,
               commit_id: comment.commit_id,
               path: comment.path,
               position: comment.original_position,

             },
             authorToken(comment.user.login));
}

async function createIssueComment(comment) {
  const issueNumber = comment.issue_url.split("/").pop();
  progress(`Creating issue comment for #${issueNumber} (${comment.id})`);
  await post(`${config.destination.url}/issues/${issueNumber}/comments`,
             {
               body: `${comment.body}\r\n\r\n${suffix(comment)}`,
             },
             authorToken(comment.user.login));
}

async function createComments(comments, missingCommits) {
  log("Creating comments");
  let missingHashes = new Set(missingCommits.map(c => c.sha));
  for (let comment of comments) {
    if (comment.pull_request_url) {
      await createPullComment(comment);
    } else if (comment.commit_id) {
      if (!missingHashes.has(comment.commit_id)) {
        await createCommitComment(comment);
      }
    } else {
      await createIssueComment(comment);
    }
  }
}

async function createLabels(labels) {
  log("Creating labels");
  labels.push({
    name: "migrated",
    color: "8fbcea",
    description: "This item originates from the migrated github.ugent.be repository",
  });
  for (let label of labels) {
    try {
      await post(`${config.destination.url}/labels`,
                 {
                   name: label.name,
                   color: label.color,
                   description: label.description,
                 },
                 config.destination.default_token);
    } catch (e) {
      debugger;
    }
  }
}

async function showRateLimit() {
  const response = await get(config.destination.url,
                             config.destination.default_token);
  const remaining = response.headers["x-ratelimit-remaining"];
  const limit = response.headers["x-ratelimit-limit"];
  log(`Rate limit: ${remaining}/${limit} remaining`);
}

async function addLabels(issue) {
  await patch(`${config.destination.url}/issues/${issue.number}`,
              {
                labels: issue.labels
                  .map(label => label.name)
                  .concat(["migrated"]),
              },
              config.destination.default_token);
}

async function updatePull(pull) {
  progress(`Updating PR #${pull.number}`);
  await addLabels(pull);
  if (pull.merged) {
    progress(`Merging PR #${pull.number}`);
    await put(`${config.destination.url}/pulls/${pull.number}/merge`,
              null,
              authorToken(pull.closed_by.login));
  } else if (pull.state === "closed") {
    await patch(`${config.destination.url}/pulls/${pull.number}`,
                {
                  state: pull.state,
                },
                authorToken(pull.closed_by.login));
  }
}

async function updateIssue(issue) {
  progress(`Updating issue #${issue.number}`);
  await addLabels(issue);
  if (issue.state === "closed") {
    await patch(`${config.destination.url}/issues/${issue.number}`,
                {
                  state: issue.state,
                },
                authorToken(issue.closed_by.login));
  }
}

async function updateIssuesAndPulls(issues) {
  log("Updating issues and pull requests");
  for (let issue of issues) {
    if (issue.pull_request) {
      await updatePull(issue);
    } else {
      await updateIssue(issue);
    }
  }
}

function cleanRemoteRepo() {
  sh(`git -C ${mirrorDir} push --mirror ${config.destination.repository}`);
}

(async () => {
  try {
    if (program.reset) {
      await resetDestination();
    }

    moveRepository();

    const issues = checkIfNeeded(issuePath)
      ? (await fetchAllIssues())
      : readJson(issuePath);

    const comments = checkIfNeeded(commentPath)
      ? (await fetchAllComments())
      : readJson(commentPath);

    const labels = checkIfNeeded(labelPath)
      ? (await fetchAllLabels())
      : readJson(labelPath);

    const items = issues.concat(comments);

    const missing = checkIfNeeded(missingPath)
      ? (await missingCommits(items))
      : readJson(missingPath);

    if (missing.length > 0) {
      warn("Missing commits detected:");
      console.dir(missing);
    }

    const creators = await findCreators(items);
    const mentions = await filterMentions(items);

    await createLabels(labels);
    await createIssuesAndPulls(issues, missing);
    await createComments(comments, missing);

    await updateIssuesAndPulls(issues);

    cleanRemoteRepo();

    await showRateLimit();
  } catch (e) {
    debugger;
    console.dir(e);
  }
})();


/* const url = config.destination.repoUrl + "/issues";
const data = {
  "title": "test issue",
  "body": "test issue aangemaakt om tokens te testen",
};

post(url, data, () => {}, config.destination.tokens["fvdrjeug"]);
*/


