#!/usr/bin/env node

import { default as colors } from "colors/safe";
import { default as childProcess } from "child_process";
import { default as fs } from "fs";
import { default as yaml } from "js-yaml";
import { default as commander } from "commander";

import axiosStatic, { AxiosResponse, AxiosInstance, Method } from "axios";
const axios: AxiosInstance = axiosStatic.create();

const program = new commander.Command();

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

/**
 * Execute in shell, while connecting stdin, stdout and stderr to that of
 * the current process
 */
function sh(commandline: string, options?: object): Buffer {
  console.log(commandline);
  return childProcess.execSync(commandline, {stdio: "inherit", ...options});
}

function warn(message: string): void {
  const date = new Date().toString().slice(0, 24);
  console.log(colors.red(`[${date}] ${message}`));
}

function log(message: string): void {
  const date = new Date().toString().slice(0, 24);
  console.log(colors.blue(colors.bold(`[${date}] ${message}`)));
}

function progress(message: string): void {
  const date = new Date().toString().slice(0, 24);
  console.log(colors.blue(`[${date}] ${message}`));
}

function writeJson(path: string, item): void {
  fs.writeFileSync(path, JSON.stringify(item, null, 2));
}

function readJson<T>(path: string): T {
  return JSON.parse(fs.readFileSync(path).toString());
}

interface Repository {
  remote: string;
  owner: string;
  name: string;
}

function parseRepoUrl(cloneUrl: string): Repository {
  const matchSsh = /^git@([^:]+):([^/]+)\/(.+)\.git$/.exec(cloneUrl);
  if (matchSsh) {
    return {remote: matchSsh[1], owner: matchSsh[2], name: matchSsh[3]};
  }
  const matchHttp = /^https?:\/\/([^/]+)\/([^/]+)\/(.+)\.git$/.exec(cloneUrl);
  if (matchHttp) {
    return {remote: matchHttp[1], owner: matchHttp[2], name: matchHttp[3]};
  }
  throw `Repository '${cloneUrl}' is not in ssh or https format.`;
}


const configFile = program.config || "./config.yml";
const config = yaml.safeLoad(fs.readFileSync(configFile));

/* eslint @typescript-eslint/camelcase: "off"*/
config.destination.admin_token = config.destination.admin_token || config.destination.default_token;

config.source.repository = program.source || config.source.repository;
config.destination.repository = program.source || config.destination.repository;

const sourceInfo = parseRepoUrl(config.source.repository);
const destInfo = parseRepoUrl(config.destination.repository);

config.source = {
  url: `${config.source.api}/repos/${sourceInfo.owner}/${sourceInfo.name}`,
  ...config.source,
  ...sourceInfo,
};

config.destination = {
  url: `${config.destination.api}/repos/${destInfo.owner}/${destInfo.name}`,
  ...config.destination,
  ...destInfo,
};

const repoDir = "data/" + config.source.reponame;
fs.mkdirSync(repoDir, {recursive: true});

const cloneDir = repoDir + "/clone";
const mirrorDir = repoDir + "/mirror.git";
const issuePath = repoDir + "/issues.json";
const labelsPath = repoDir + "/labels.json";
const missingPath = repoDir + "/missing.json";
const commentPath = repoDir + "/comments.json";
const releasesPath = repoDir + "/releases.json";
const mentionsPath = repoDir + "/mentions.json";
const creatorsPath = repoDir + "/creators.json";

async function invoke(method: Method, url: string, data?: object, token?: string): Promise<AxiosResponse> {
  try {
    return await axios.request({
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

function get(url: string, token?: string): Promise<AxiosResponse> {
  return invoke("get", url, null, token);
}

function destroy(url: string, token?: string): Promise<AxiosResponse> {
  return invoke("delete", url, null, token);
}

function patch(url, data, token?): Promise<AxiosResponse> {
  return invoke("patch", url, data, token);
}

function post(url, data, token?): Promise<AxiosResponse> {
  return invoke("post", url, data, token);
}

function put(url, data, token?): Promise<AxiosResponse> {
  return invoke("put", url, data, token);
}



/**
 * Call and await the given callback with an increasing integer while
 * collecting the result in an array. Continues until the callback returns
 * null.
 */
async function collectUntilNull<T>(callback: (number) => Promise<T | null>)
  : Promise<T[]>  {
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

/*
async function fetchReviews(issues): object {
  log("Fetching reviews and review comments");
  for (let pr of issues.filter(issue => issue.pull_request)) {
    //
  }
}
*/

type URL = string;

interface Item {
  id: number;
  url: URL;
  html_url: URL;
  created_at: Date;
}

interface Authorable extends Item {
  user: User;
  body: string;
}

/*
function isAuthorable(item: Item): item is Authorable  {
  return (item as Authorable).user !== undefined;
}
*/

interface Issue extends Authorable {
  number: number;
  title: string;
  events_url: URL;
  closed_by: User;
  closed_at: Date;
  labels: Label[];
}

function isIssue(item: Item): item is Issue {
  return (item as Issue).labels !== undefined;
}

interface PRIssue extends Issue {
  pull_request: object;
  base: Commit;
  head: Commit;
  merged: boolean;
}

function isPR(item: Item): item is PRIssue  {
  return (item as PRIssue).pull_request !== undefined;
}

interface Comment extends Authorable {
  created_at: Date;
}

interface User {
  login: string;
}

interface Release extends Authorable {
  name: string;
  tag: string;
}

interface Label extends Item {
  name: string;
  color: string;
}

interface Commit {
  url: string;
  sha: string;
}

interface PRComment extends Comment {
  pull_request_url: URL;
  path: string;
  original_commit_id: string;
  original_position: number;
}

function isPRComment(item: Item): item is PRComment {
  return (item as PRComment).pull_request_url !== undefined;
}

interface CommitComment extends Comment {
  commit_id: string;
  path: string;
  original_position: number;
}

function isCommitComment(item: Item): item is CommitComment {
  return (item as CommitComment).commit_id !== undefined;
}

interface IssueComment extends Comment {
  issue_url: string;
}

function isIssueComment(item: Item): item is IssueComment {
  return (item as IssueComment).issue_url !== undefined;
}

async function fetchIssue(issueNumber): Promise<Issue> {
  progress(`Fetching issue ${issueNumber}`);
  try {
    const request = await get(`${config.source.url}/issues/${issueNumber}`);

    const issue = request.data as Issue;
    if (isPR(issue)) {
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

async function fetchIssues(): Promise<Issue[]> {
  log("Fetching issues");
  const issues = (await collectUntilNull<Issue>(fetchIssue))
    .sort((a, b) => a.number - b.number);
  writeJson(issuePath, issues);
  return issues;
}


async function collectPages<T>(type): Promise<T[]> {
  return [].concat(...(await collectUntilNull(async page => {
    const response = await get(`${config.source.url}/${type}?` +
                               `page=${page}&state=all&per_page=100`);
    if (response.data.length === 0) {
      return null;
    }
    return response.data;
  })));
}

async function fetchLabels(): Promise<Label[]> {
  log("Fetching labels");
  const labels = await collectPages<Label>("labels");
  writeJson(labelsPath, labels);
  return labels;
}

async function fetchReleases(): Promise<Release[]> {
  log("Fetching releases");
  const releases = await collectPages<Release>("releases");
  writeJson(releasesPath, releases);
  return releases;
}

async function fetchComments(): Promise<Comment[]> {
  log("Fetching comments");
  progress("Fetching pull comments");
  const pullComments = await collectPages("pulls/comments");
  progress("Fetching issue comments");
  const issueComments = await collectPages("issues/comments");
  progress("Fetching commit comments");
  const commitComments = await collectPages("comments");
  const comments = []
    .concat(...pullComments)
    .concat(...issueComments)
    .concat(...commitComments)
    .sort((a: Comment, b: Comment): number =>
      new Date(a.created_at).valueOf() - new Date(b.created_at).valueOf());
  writeJson(commentPath, comments);
  return comments;
}

function checkIfNeeded(path: string): boolean {
  if (fs.existsSync(path)) {
    if (program.overwrite) {
      sh(`rm -rf ${path}`);
    } else {
      return false;
    }
  }
  return true;
}


function moveRepository(): void {
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

async function commitExists(sha: string): Promise<boolean> {
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


async function missingCommits(items): Promise<Commit[]> {
  const commits = items
    .map((item): Commit | null => {
      if (item.base) { // Pull Request
        return {url: item.html_url, sha: item.base.sha};
      } else if (item.pull_request_url) { // Review comment
        return {url: item.html_url, sha: item.original_commit_id};
      } else if (item.commit_id) { // Commit comment
        return {url: item.html_url, sha: item.commit_id};
      } else {
        return null;
      }
    })
    .filter((item): boolean => item !== null);

  const checked = new Set();
  const missing = [];
  for (const commit of commits) {
    if (!checked.has(commit.sha)) {
      checked.add(commit.sha);
      const exists = await commitExists(commit.sha);
      if (!exists) {
        missing.push(commit);
      }
    }
  }

  writeJson(missingPath, missing);
  return missing;
}

async function createBranch(branchname, sha): Promise<void> {
  progress(`Creating branch ${branchname}`);
  try {
    await post(`${config.destination.url}/git/refs`,
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

function formatDate(date: Date): string {
  const items = new Date(date).toString().split(" ");
  const day = items.slice(0, 4).join(" ");
  const time = items[4].split(":").slice(0, 2).join(":");
  return `${day} at ${time}`;
}

function authorToken(srcUser: string): string {
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

function author(srcUser: User): string {
  const user = config.destination.usernames[srcUser.login];
  return user ? `\`@${user}\`` : srcUser.login; // TODO: actually mention
}

function suffix(item: Authorable): string {
  let type;
  if (isPR(item)) {
    type = "pull request";
  } else if (isIssue(item)) {
    type = "issue";
  } else {
    type = "comment";
  }

  let suffix = `_[Original ${type}](${item.html_url})`;
  suffix += ` by ${author(item.user)}`;
  suffix += ` on ${formatDate(item.created_at)}._`;
  if (isIssue(item)) {
    suffix += `\n_${isPR(item) ? "Merged" : "Closed"} `;
    if (isIssue(item)) {
      suffix += ` by ${author(item.closed_by)}`;
    }
    suffix += ` on ${formatDate(item.closed_at)}._`;
  }
  return suffix;
}

interface BranchNames {
  head: string;
  base: string;
}

function branchNames(pull): BranchNames {
  return {
    head: `migrated/pr-${pull.number}/${pull.head.ref}`,
    base: `migrated/pr-${pull.number}/${pull.base.ref}`,
  };
}

async function createBrokenPullRequest(pull): Promise<void> {
  progress(`Creating dummy branches for PR #${pull.number}`);

  const {head, base} = branchNames(pull);

  sh(`git -C ${cloneDir} checkout master`);
  sh(`git -C ${cloneDir} checkout -B ${base}`);
  sh(`git -C ${cloneDir} push ${config.destination.repository} ${base}`);

  sh(`git -C ${cloneDir} checkout -B ${head}`);

  const authorName = config.destination.committer_name;
  const authorEmail = config.destination.committer_email;
  sh(`GIT_COMMITTER_NAME="${authorName}" GIT_COMITTER_EMAIL="${authorEmail}"` +
     `GIT_AUTHOR_NAME="${authorName}" GIT_AUTHOR_EMAIL="${authorEmail}" ` +
     `git -C ${cloneDir} commit --allow-empty --message "Dummy commit for PR #${pull.number}"`);

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

async function createPullRequest(pull): Promise<void> {
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

async function createIssue(issue: Issue): Promise<void> {
  progress(`Creating issue #${issue.number}`);
  await post(`${config.destination.url}/issues`,
             {
               title: issue.title,
               body: `${issue.body}\r\n\r\n${suffix(issue)}`,
             },
             authorToken(issue.user.login));
}

async function createIssuesAndPulls(issues: Issue[], missing: Commit[]): Promise<void> {
  log("Creating issues and pull requests");
  const missingHashes = new Set(missing.map((c): string => c.sha));
  for (const issue of issues) {
    if (isPR(issue)) {
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

async function findCreators(items: Authorable[]): Promise<User[]> {
  log("Searching for creator usernames");
  const creatorSet = new Set(items.map((item: Authorable): User => item.user));
  const creators = Array.from(creatorSet);
  writeJson(creatorsPath, creators);
  return creators;
}

async function filterMentions(items: Authorable[]): Promise<Map<string, string>> {
  log("Filtering mentioned usernames");
  const regex = /@[-A-z0-9]{1,39}/;
  const mentions = new Map();
  for (const item of items) {
    const body = item.body;

    const parts = [];

    let last = 0;
    let match = regex.exec(body);
    while (match) {
      parts.push(body.slice(last, last + match.index));
      const username = match[0].slice(1);

      if (!mentions.has(username)) {
        try {
          const response = await get(`${config.source.api}/users/${username}`);
          const user = response.data;
          mentions.set(username, user.email);
        } catch (e) {
          // ignore, user does not exist
        }
      }

      const newName = config.destination.usernames[username];
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

/**
 * Reset the destination repository by deleting and recreating it. This needs
 * the 'delete_repositories' scope. Use with caution.
 */
async function resetDestination(): Promise<void> {
  progress("Deleting destination repository");
  await destroy(config.destination.url, config.destination.admin_token);
  progress("Creating destination repository");
  await post(`${config.destination.api}/orgs/${config.destination.owner}/repos`,
             {name: config.destination.reponame, private: true},
             config.destination.admin_token);
}

async function createPullComment(comment: PRComment): Promise<void> {
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

async function createCommitComment(comment: CommitComment): Promise<void> {
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

async function createIssueComment(comment: IssueComment): Promise<void> {
  const issueNumber = comment.issue_url.split("/").pop();
  progress(`Creating issue comment for #${issueNumber} (${comment.id})`);
  await post(`${config.destination.url}/issues/${issueNumber}/comments`,
             {
               body: `${comment.body}\r\n\r\n${suffix(comment)}`,
             },
             authorToken(comment.user.login));
}

async function createComments(comments, missingCommits): Promise<void> {
  log("Creating comments");
  const missingHashes = new Set(missingCommits.map(c => c.sha));
  for (const comment of comments) {
    if (isPRComment(comment)) {
      await createPullComment(comment);
    } else if (isCommitComment(comment)) {
      if (!missingHashes.has(comment.commit_id)) {
        await createCommitComment(comment);
      }
    } else if (isIssueComment(comment)) {
      await createIssueComment(comment);
    } else {
      throw "Unknown comment type";
    }
  }
}

async function createLabels(labels): Promise<void> {
  log("Creating labels");
  labels.push({
    name: "migrated",
    color: "8fbcea",
    description: "This item originates from the migrated github.ugent.be repository",
  });
  for (const label of labels) {
    await post(`${config.destination.url}/labels`,
               {
                 name: label.name,
                 color: label.color,
                 description: label.description,
               },
               config.destination.default_token);
  }
}

async function showRateLimit(): Promise<void> {
  const response = await get(config.destination.url,
                             config.destination.default_token);
  const remaining = response.headers["x-ratelimit-remaining"];
  const limit = response.headers["x-ratelimit-limit"];
  log(`Rate limit: ${remaining}/${limit} remaining`);
}

async function addLabels(issue: Issue): Promise<void> {
  await patch(`${config.destination.url}/issues/${issue.number}`,
              {
                labels: issue.labels
                  .map(label => label.name)
                  .concat(["migrated"]),
              },
              config.destination.default_token);
}

function mergeUnmergeable(pull) {
  const {head, base} = branchNames(pull);
  sh(`git -C ${cloneDir} fetch`);
  sh(`git -C ${cloneDir} checkout ${base}`);

  // Merge using the 'ours' strategy, which resolves conflicts for us
  const authorName = config.destination.committer_name;
  const authorEmail = config.destination.committer_email;
  sh(`GIT_COMMITTER_NAME="${authorName}" GIT_COMITTER_EMAIL="${authorEmail}"` +
     `GIT_AUTHOR_NAME="${authorName} GIT_AUTHOR_EMAIL=${authorEmail}" ` +
     `git -C ${cloneDir} merge origin/${head} -s ours --no-edit`);

  sh(`git -C ${cloneDir} push ${config.destination.repository} ${base}`);
  sh(`git -C ${cloneDir} checkout master`);
}

async function updatePull(pull) {
  progress(`Updating PR #${pull.number}`);
  await addLabels(pull);
  if (pull.merged) {
    progress(`Merging PR #${pull.number}`);
    try {
      await put(`${config.destination.url}/pulls/${pull.number}/merge`,
                null,
                authorToken(pull.closed_by.login));
    } catch (e) {
      if (e.response.status === 405) {
        warn("Unmergeable commit encountered, trying to merge manually...");
        mergeUnmergeable(pull);
      } else {
        throw e;
      }
    }
  } else if (pull.state === "closed") {
    await patch(`${config.destination.url}/pulls/${pull.number}`,
                {
                  state: pull.state,
                },
                authorToken(pull.closed_by.login));
  }
}

async function createReleases(releases) {
  log("Creating releases");
  for (let release of releases) {
    progress(`Creating release ${release.name}`);
    await post(`${config.destination.url}/releases`,
               {
                 name: release.name,
                 tag_name: release.tag_name,
                 body: release.body,
                 draft: release.draft,
                 prerelease: release.prerelease,
               },
               authorToken(release.author.login));
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
  log("Clean destination remote of temporary branches");
  sh(`git -C ${mirrorDir} push --mirror ${config.destination.repository}`);
}

(async () => {
  try {
    if (program.reset) {
      await resetDestination();
    }

    moveRepository();

    const issues = checkIfNeeded(issuePath)
      ? (await fetchIssues())
      : readJson<Issue[]>(issuePath);

    const comments = checkIfNeeded(commentPath)
      ? (await fetchComments())
      : readJson<Comment[]>(commentPath);

    const labels = checkIfNeeded(labelsPath)
      ? (await fetchLabels())
      : readJson<Label[]>(labelsPath);

    const releases = checkIfNeeded(releasesPath)
      ? (await fetchReleases())
      : readJson<Release[]>(releasesPath);

    const items: Authorable[] = [].concat(issues, comments);

    const missing = checkIfNeeded(missingPath)
      ? (await missingCommits(items))
      : readJson<Commit[]>(missingPath);

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
    await createReleases(releases);

    cleanRemoteRepo();

    await showRateLimit();
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


