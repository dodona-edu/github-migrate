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
  .option("-s, --skip-existing",
          "Skip steps if a file already exists.")
  .parse(process.argv);

const configFile = program.config || "./config.yml";
const config = yaml.safeLoad(fs.readFileSync(configFile));

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

const repoDir = "data/" + config.destination.reponame;
fs.mkdirSync(repoDir, {recursive: true});

const cloneDir = repoDir + "/clone.git";
const issuePath = repoDir + "/issues.json";
const commentPath = repoDir + "/comments.json";
const missingPath = repoDir + "/missingCommits.json";

function assert(assertion, message) {
  if (!assertion) throw (message || "AssertionError");
}

async function invoke(method, url, data, token) {
  try {
    return await axios({
      method: method,
      url: url,
      data: data,
      validateStatus: s => s === 404 || (s >= 200 && s < 300),
      headers: {
        "Authorization": "token " + (token || config.source.token),
        "User-Agent": "node.js",
      },
    });
  } catch (e) {
    const response = e.response;
    if (response.status === 403 &&
        response.headers["x-ratelimit-remaining"] === 0) {
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

function patch(url, data, token) {
  return invoke("patch", url, data, token);
}

function post(url, data, token) {
  return invoke("post", url, data, token);
}

/**
 * Call and await the given callback with an increasing integer while
 * collecting the result in an array. Continues until the callback returns
 * null.
 */
async function collectUntilNull(callback, start) {
  let i = start || 0;
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
  const request = await get(`${config.source.url}/issues/${issueNumber}`);
  if (request.status === 404) {
    return null;
  }

  const issue = request.data;
  if (issue.pull_request) {
    const pull = await get(`${config.source.url}/pulls/${issueNumber}`);
    issue.base = pull.data.base;
    issue.head = pull.data.head;
  }
  // writeJson(`${issueDir}/issue${issueNumber}.json`, issue);
  return issue;
}

async function fetchAllIssues() {
  log("Fetching issues");
  const issues = (await collectUntilNull(fetchIssue, 1))
    .sort((a, b) => a.number - b.number);
  writeJson(`${repoDir}/issues.json`, issues);
  return issues;
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
    .concat(pullComments)
    .concat(issueComments)
    .concat(commitComments)
    .sort((a, b) => a.created_at - b.created_at);
  writeJson(`${repoDir}/comments.json`, comments);
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
  log("Moving repository");
  progress("Cloning from source");
  sh(`git clone --mirror ${config.source.repository} ${cloneDir}`);
  progress("Replacing packed-refs");
  sh(`sed -i.bak 's_ refs/pull/_ refs/pr/_' ${cloneDir}/packed-refs`);
  progress("Pushing to destination");
  sh(`git -C ${cloneDir} push --mirror ${config.destination.repository}`);
}

async function commitExists(sha) {
  const url = `${config.destination.url}/git/commits/${sha}`;
  const response = await get(url, config.destination.default_token);
  assert(response.status);
  return response.status !== 404;
}

// TODO: also check for item.head
async function missingCommits(issues, comments) {
  const commits = []
    .concat(issues)
    .concat(comments)
    .map(item => {
      if (item.base) { // Pull Request
        return {url: item.url, sha: item.base.sha};
      } else if (item.pull_request_url) { // Review comment
        return {url: item.url, sha: item.original_commit_id};
      } else if (item.commit_id) { // Commit comment
        return {url: item.url, sha: item.commit_id};
      }
    })
    .filter(item => item !== undefined)
    .map(async item => ({...item, exists: await commitExists(item.sha)}));

  const missing = (await Promise.all(commits)).filter(item => !item.exists);
  writeJson(`${repoDir}/missing.json`, missing);
  return missing;
}

async function createPullReference(pull) {
  progress(`Creating reference for #${pull.number}`);
  await post(`${config.destination.url}/git/refs`,
             {
               "ref": `refs/heads/pr-${pull.number}-base`,
               "sha": pull.base.sha,
             },
             config.destination.default_token);
}

async function createPullReferences(issues) {
  for (let pull of issues.filter(issue => issue.base)) {
    await createPullReference(pull);
  }
}

function prefix(item) {
  let prefix = `Originally authored by ${item.user.login}` +
    ` on ${item.created_at.toString()}.`;
  if (item.closed_at) {
    prefix += " Closed ";
    if (item.closed_by) {
      prefix += ` by ${item.closed_by.login}`;
    }
    prefix += ` on ${item.closed_at.toString()}.`;
  }
  return prefix;
}

async function createPullRequest(pull) {
  try {
    await post(`${config.destination.url}/pulls`,
               {
                 title: pull.title,
                 body: `${prefix(pull)}\r\n\r\n${pull.body}`,
                 head: `pr/${pull.number}/head`,
                 base: `pr-${pull.number}-base`,
               },
               config.destination.default_token);
  } catch (e) {
    throw e;
  }
}

async function createIssue(issue) {
  await post(`${config.destination.url}/issues`,
             {
               "title": issue.title,
               "body": `${prefix(issue)}\r\n\r\n${issue.body}`,
             },
             config.destination.default_token);
}

async function createIssuesAndPulls(issues) {
  log("Creating issues and pull requests");
  for (let issue of issues) {
    if (issue.pull_request) {
      await createPullRequest(issue);
    } else {
      await createIssue(issue);
    }
  }
}

function checkIfNeeded(path) {
  debugger;
  if (fs.existsSync(path)) {
    if (program.skipExisting) {
      return false;
    } else {
      sh(`rm -rf ${path}`);
    }
  }
  return true;
}

(async () => {
  try {
    if (checkIfNeeded(cloneDir)) {
      moveRepository();
    }

    // TODO
    const issues = false //checkIfNeeded(issuePath)
      ? (await fetchAllIssues())
      : readJson(issuePath);

    const comments = false // checkIfNeeded(commentPath)
      ? (await fetchAllComments())
      : readJson(commentPath);

    const missing = checkIfNeeded(missingPath)
      ? (await missingCommits(issues, comments))
      : readJson(missingPath);

    if (missing.length > 0) {
      console.dir(missing);
      throw "Missing commits detected";
    }

    await createPullReferences(issues);
    // await createIssuesAndPulls(issues);
  } catch (e) {
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


