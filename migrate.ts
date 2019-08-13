#!/usr/bin/env ts-node

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
  .option("-f, --for-real",
          "Perform the migration while using the actual user tokens " +
          "and actually mentioning users. This wil cause GitHub to send" +
          "a lot of emails.")
  .parse(process.argv);

process.on("unhandledRejection", reason => {
  console.log("Unhandled Rejection");
  console.dir(reason, {depth: 4});
  process.exit(1);
});

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

function writeJson(path: string, item: object): void {
  fs.writeFileSync(path, JSON.stringify(item, null, 2));
}

function readJson<T>(path: string): T {
  return JSON.parse(fs.readFileSync(path).toString());
}

interface Repository {
  remote: string;
  owner: string;
  name: string;
  url: URL;
}

class Token {
  private token: string;
  public constructor(token: string) {
    this.token = token;
  }
  public toString(): string {
    return this.token;
  }
}

class URL {
  private url: string;
  public constructor(url: string) {
    this.url = url;
  }
  public toString(): string {
    return this.url;
  }
}

function url(url: string): URL {
  return new URL(url);
}

function parseRepoUrl(cloneUrl: string): Repository {
  const matchSsh = /^git@([^:]+):([^/]+)\/(.+)\.git$/.exec(cloneUrl);
  if (matchSsh) {
    return {remote: matchSsh[1], owner: matchSsh[2], name: matchSsh[3], url: url(cloneUrl)};
  }
  const matchHttp = /^https?:\/\/([^/]+)\/([^/]+)\/(.+)\.git$/.exec(cloneUrl);
  if (matchHttp) {
    return {remote: matchHttp[1], owner: matchHttp[2], name: matchHttp[3], url: url(cloneUrl)};
  }
  throw `Repository '${cloneUrl}' is not in ssh or https format.`;
}

interface Config {
  reset: boolean;
  overwrite: boolean;
  for_real: boolean;
  source: SourceConfig;
  destination: DestinationConfig;
}

interface SourceConfig {
  url: URL;
  api: string;
  repo: Repository;
  token: Token;
}

interface DestinationConfig {
  url: URL;
  api: string;
  repo: Repository;
  default_token: Token;
  admin_token: Token;
  committer_name: string;
  committer_email: string;
  usernames: StringMap<string>;
  tokens: StringMap<Token>;
}

interface StringMap<T> {
  [key: string]: T;
}

const configFile = program.config || "./config.yml";
if (!fs.existsSync(configFile)) {
  warn(`Config file ${configFile} does not exist. `
    + " You can copy the example configuration from config.example.yml");
  process.exit(1);
}

const cfgObj = yaml.safeLoad(fs.readFileSync(configFile).toString());

/* eslint @typescript-eslint/camelcase: "off"*/
cfgObj.destination.admin_token = cfgObj.destination.admin_token || cfgObj.destination.default_token;

cfgObj.source.repository = program.source || cfgObj.source.repository;
cfgObj.destination.repository = program.destination || cfgObj.destination.repository;

const srcRepo = parseRepoUrl(cfgObj.source.repository);
const dstRepo = parseRepoUrl(cfgObj.destination.repository);

const tokens: StringMap<Token> = {};
for (const [key, token] of Object.entries(cfgObj.destination.tokens)) {
  tokens[key] = new Token(token as string);
}

const config: Config = {
  reset: program.reset,
  overwrite: program.overwrite,
  for_real: program.forReal || cfgObj.for_real,
  source: {
    url: url(`${cfgObj.source.api}/repos/${srcRepo.owner}/${srcRepo.name}`),
    repo: srcRepo,
    ...cfgObj.source,
    token: new Token(cfgObj.source.token),
  },
  destination: {
    url: url(`${cfgObj.destination.api}/repos/${dstRepo.owner}/${dstRepo.name}`),
    repo: dstRepo,
    ...cfgObj.destination,
    default_token: new Token(cfgObj.destination.default_token),
    admin_token: new Token(cfgObj.destination.admin_token),
    tokens: tokens,
  }
}


const repoDir = "data/" + config.source.repo.name;
fs.mkdirSync(repoDir, {recursive: true});

const cloneDir = repoDir + "/clone";
const mirrorDir = repoDir + "/mirror.git";
const issuePath = repoDir + "/issues.json";
const labelsPath = repoDir + "/labels.json";
const milestonesPath = repoDir + "/milestones.json";
const missingPath = repoDir + "/missing.json";
const commentPath = repoDir + "/comments.json";
const releasesPath = repoDir + "/releases.json";
const mentionsPath = repoDir + "/mentions.json";
const creatorsPath = repoDir + "/creators.json";

async function invoke(method: Method, url: URL, token?: Token, data?: object): Promise<AxiosResponse> {
  try {
    console.log(`${method.toUpperCase()} ${url}`);
    return await axios.request({
      method: method,
      url: url.toString(),
      data: data,
      headers: {
        "Authorization": "token " + (token || config.source.token).toString(),
        "User-Agent": "node.js",
      },
    });
  } catch (e) {
    const response = e.response;
    if (response.status === 403 &&
        response.headers["x-ratelimit-remaining"] == 0) {
      warn("Ratelimit encountered, retrying in 1 second");
      sh("sleep 1");
      return await invoke(method, url, token, data);
    } if (response.status === 500) {
      warn("Got internal server error, retrying in 1 second");
      sh("sleep 1");
      return await invoke(method, url, token, data);
    } else {
      throw e;
    }
  }
}

function get(url: URL, token?: Token): Promise<AxiosResponse> {
  return invoke("get", url, token);
}

function destroy(url: URL, token?: Token): Promise<AxiosResponse> {
  return invoke("delete", url, token);
}

function patch(url: URL, data: object, token?: Token): Promise<AxiosResponse> {
  return invoke("patch", url, token, data);
}

function post(url: URL, data: object, token?: Token): Promise<AxiosResponse> {
  return invoke("post", url, token, data);
}

function put(url: URL, data: object, token?: Token): Promise<AxiosResponse> {
  return invoke("put", url, token, data);
}

/**
 * Call and await the given callback with an increasing integer while
 * collecting the result in an array. Continues until the callback returns
 * null.
 */
async function collectUntilNull<T>(
  callback: (n: number) => Promise<T | null>
): Promise<T[]>  {
  let i = 1;
  const collector: T[] = [];
  let result = await callback(i);
  while (result) {
    i += 1;
    collector.push(result);
    result = await callback(i);
  }
  return collector;
}

interface Item {
  id: number;
  url: URL;
  created_at: string;
}

interface Authorable extends Item {
  user: User;
  html_url: string;
  body: string;
}

interface Issue extends Authorable {
  number: number;
  title: string;
  state: string;
  events_url: string;
  closed_by: User;
  closed_at: string;
  labels: Label[];
  milestone?: Milestone;
}

function isIssue(item: Item): item is Issue {
  return (item as Issue).labels !== undefined;
}

interface PullRequest extends Issue {
  pull_request: object;
  base: Commit;
  head: Commit;
  merged: boolean;
}

function isPR(item: Item): item is PullRequest  {
  return (item as PullRequest).pull_request !== undefined;
}

interface Comment extends Authorable {
}

interface User {
  login: string;
}

interface Release extends Item {
  name: string;
  body: string;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  author: User;
}

interface Label {
  name: string;
  color: string;
  description: string;
}

interface Milestone {
  number: number;
  title: string;
  state: string;
  description: string;
  due_on?: string;
}

interface Commit {
  ref?: string;
  url: URL;
  sha: string;
}

interface PRComment extends Comment {
  pull_request_url: string;
  path?: string;
  original_commit_id: string;
  original_position?: number;
}


function isPRComment(item: Item): item is PRComment {
  const comment = item as PRComment;
  return comment.pull_request_url !== undefined &&
         comment.original_commit_id !== undefined;
}

interface CommitComment extends Comment {
  commit_id: string;
  path: string;
  original_position: number;
  submitted_at: string;
}

function isCommitComment(item: Item): item is CommitComment {
  return (item as CommitComment).commit_id !== undefined &&
         (item as Review).pull_request_url === undefined;
}

interface IssueComment extends Comment {
  issue_url: string;
}

function isIssueComment(item: Item): item is IssueComment {
  return (item as IssueComment).issue_url !== undefined;
}


interface Review extends Comment {
  commit_id: string;
  event: string;
  pull_request_url: string;
  submitted_at: string;
}

function isReview(item: Item): item is Review {
  const review = item as Review;
  return review.pull_request_url !== undefined && review.event !== undefined;
}


interface Event {
  event: string;
}

async function collectPages<T>(type: string): Promise<T[]> {
  return [].concat(...(await collectUntilNull(async page => {
    const response = await get(url(`${config.source.url}/${type}?` +
                               `page=${page}&state=all&per_page=100`));
    if (response.data.length === 0) {
      return null;
    }
    return response.data;
  })));
}

async function fetchPR(issue: Issue): Promise<PullRequest> {
  const pr = (await get(url(`${config.source.url}/pulls/${issue.number}`))).data;
  const events: Event[] = (await get(url(issue.events_url))).data;

  return {
    ...issue,
    ...pr,
    merged: events.some(e => e.event === "merged")
  };
}

async function fetchIssue(issueNumber: number): Promise<Issue | null> {
  progress(`Fetching issue ${issueNumber}`);
  try {
    const request = await get(url(`${config.source.url}/issues/${issueNumber}`));
    const issue = request.data as Issue;

    if (isPR(issue)) {
      return await fetchPR(issue);
    } else {
      return issue;
    }

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

async function fetchLabels(): Promise<Label[]> {
  log("Fetching labels");
  const labels = await collectPages<Label>("labels");
  writeJson(labelsPath, labels);
  return labels;
}

async function fetchMilestones(): Promise<Milestone[]> {
  log("Fetching milestones");
  const milestones = (await collectPages<Milestone>("milestones"))
    .sort((a, b) => a.number - b.number);
  writeJson(milestonesPath, milestones);
  return milestones;
}

async function fetchReleases(): Promise<Release[]> {
  log("Fetching releases");
  const releases = await collectPages<Release>("releases");
  writeJson(releasesPath, releases);
  return releases;
}

interface ReviewObj {
  submitted_at: string;
  state: string;
  body: string;
}

async function fetchReviews(issues: Issue[]): Promise<Review[]> {
  const reviews: Review[] = [];
  const reviewEvent: Map<string, string> = new Map(
    [["APPROVED", "APPROVE"],
      ["COMMENTED", "COMMENT"],
      ["CHANGES_REQUESTED", "REQUEST_CHANGES"]]
  );
  for (const issue of issues.filter(issue => isPR(issue))) {
    const reviewObjs = await collectPages<ReviewObj>(`pulls/${issue.number}/reviews`);


    for (const reviewObj of reviewObjs) {
      // GitHub API ლ(ಠ益ಠ)ლ
      const event = reviewEvent.get(reviewObj.state);
      if (event === null) { throw "Unknown event state: " + reviewObj.state }
      const review = {
        ...reviewObj,
        created_at: reviewObj.submitted_at,
        event: event,
      };
      reviews.push((review as unknown) as Review);
    }
  }
  return reviews;
}

async function fetchComments(issues: Issue[]): Promise<Comment[]> {
  log("Fetching comments");
  progress("Fetching pull comments");
  const pullComments = await collectPages<PRComment>("pulls/comments");
  progress("Fetching issue comments");
  const issueComments = await collectPages<IssueComment>("issues/comments");
  progress("Fetching commit comments");
  const commitComments = await collectPages<CommitComment>("comments");
  progress("Fetching review comments");
  const reviewComments = await fetchReviews(issues);
  const comments = ([] as Comment[])
    .concat(pullComments, issueComments, commitComments, reviewComments)
    .sort((a, b) =>
      new Date(a.created_at).valueOf() - new Date(b.created_at).valueOf());
  writeJson(commentPath, comments);
  return comments;
}

function checkIfNeeded(path: string): boolean {
  if (fs.existsSync(path)) {
    if (config.overwrite) {
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
    sh(`git clone --mirror ${config.source.repo.url} ${mirrorDir}`);
    sh(`git -C ${mirrorDir} remote set-url origin ${config.destination.repo.url}`);
    sh(`git -C ${mirrorDir} remote set-url --push origin ${config.destination.repo.url}`);
    progress("Replacing packed-refs");
    sh(`sed -i.bak 's_ refs/pull/_ refs/pr/_' ${mirrorDir}/packed-refs`);
  }
  progress("Pushing to destination");
  sh(`git -C ${mirrorDir} push --mirror ${config.destination.repo.url}`);

  if (checkIfNeeded(cloneDir)) {
    progress("Creating clone from destination");
    sh(`git clone ${config.destination.repo.url} ${cloneDir}`);
  }
}

async function commitExists(sha: string): Promise<boolean> {
  try {
    await get(url(`${config.destination.url}/git/commits/${sha}`),
              config.destination.default_token);
    return true;
  } catch (e) {
    if (e.response.status == 404) {
      return false;
    } else {
      throw e;
    }
  }
}

async function missingCommits(items: Item[]): Promise<Commit[]> {
  const commits = items
    .map((item): Commit | null => {
      if (isPR(item)) {
        return {url: url(item.html_url), sha: item.base.sha};
      } else if (isPRComment(item)) {
        return {url: url(item.html_url), sha: item.original_commit_id};
      } else if (isCommitComment(item)) {
        return {url: url(item.html_url), sha: item.commit_id};
      } else if (isReview(item)) {
        return {url: url(item.html_url), sha: item.commit_id};
      } else {
        return null;
      }
    })
    .filter((item): item is Commit => item !== null);

  const checked = new Set();
  const missing: Commit[] = [];
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

async function createBranch(branchname: string, sha: string): Promise<void> {
  progress(`Creating branch ${branchname}`);
  try {
    await post(url(`${config.destination.url}/git/refs`),
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

function formatDate(date: string): string {
  const items = new Date(date).toString().split(" ");
  const day = items.slice(0, 4).join(" ");
  const time = items[4].split(":").slice(0, 2).join(":");
  return `${day} at ${time}`;
}

function authorToken(srcUser: User): Token {
  const token = config.destination.tokens[srcUser.login];
  if (!token) {
    warn(`Missing token for ${srcUser.login}, using default token`);
  }
  if (config.for_real) {
    return token || config.destination.default_token;
  } else {
    return config.destination.default_token;
  }
}

function author(srcUser: User): string {
  const user = config.destination.usernames[srcUser.login];
  if (config.for_real) {
    return user ? `@${user}` : srcUser.login;
  } else {
    return user ? `\`@${user}\`` : srcUser.login;
  }
}

function suffix(item: Authorable): string {
  let type;
  if (isPR(item)) {
    type = "pull request";
  } else if (isIssue(item)) {
    type = "issue";
  } else if (isReview(item)) {
    if (item.event === "APPROVE") {
      type = "approval";
    } else if (item.event === "REQUEST_CHANGES") {
      type = "change request";
    } else {
      type = "review";
    }
  } else {
    type = "comment";
  }

  let suffix = `_[Original ${type}](${item.html_url})`;
  suffix += ` by ${author(item.user)}`;
  suffix += ` on ${formatDate(item.created_at)}._`;
  if (isIssue(item) && item.state === "closed") {
    suffix += `\n_${isPR(item) ? "Merged" : "Closed"} `
    suffix += `by ${author(item.closed_by)}`;
    suffix += ` on ${formatDate(item.closed_at)}._`;
  }
  return suffix;
}

interface BranchNames {
  head: string;
  base: string;
}

function branchNames(pull: PullRequest): BranchNames {
  return {
    head: `migrated/pr-${pull.number}/${pull.head.ref}`,
    base: `migrated/pr-${pull.number}/${pull.base.ref}`,
  };
}

async function createBrokenPullRequest(pull: PullRequest): Promise<void> {
  progress(`Creating dummy branches for PR #${pull.number}`);

  const {head, base} = branchNames(pull);

  sh(`git -C ${cloneDir} checkout master`);
  sh(`git -C ${cloneDir} checkout -B ${base}`);
  sh(`git -C ${cloneDir} push ${config.destination.repo.url} ${base}`);

  sh(`git -C ${cloneDir} checkout -B ${head}`);

  const authorName = config.destination.committer_name;
  const authorEmail = config.destination.committer_email;
  sh(`GIT_COMMITTER_NAME="${authorName}" GIT_COMITTER_EMAIL="${authorEmail}" ` +
     `GIT_AUTHOR_NAME="${authorName}" GIT_AUTHOR_EMAIL="${authorEmail}" ` +
     `git -C ${cloneDir} commit --allow-empty --message "Dummy commit for PR #${pull.number}"`);

  sh(`git -C ${cloneDir} push ${config.destination.repo.url} ${head}`);
  sh(`git -C ${cloneDir} checkout master`);

  progress(`Creating broken PR #${pull.number}`);
  const notice = `_**Note:** the base commit (${pull.base.sha}) is lost,` +
    " so unfortunately we cannot show you the changes added by this PR._";
  await post(url(`${config.destination.url}/pulls`),
             {
               title: pull.title,
               body: `${pull.body}\n\n${suffix(pull)}\n\n${notice}\n\n`,
               head: head,
               base: base,
             },
             authorToken(pull.user));
}

async function createPullRequest(pull: PullRequest): Promise<void> {
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
    await post(url(`${config.destination.url}/pulls`),
               {
                 title: pull.title,
                 body: `${pull.body}\n\n${suffix(pull)}`,
                 head: head,
                 base: base,
               },
               authorToken(pull.user));
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
  await post(url(`${config.destination.url}/issues`),
             {
               title: issue.title,
               body: `${issue.body}\n\n${suffix(issue)}`,
             },
             authorToken(issue.user));
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

    const parts: string[] = [];

    let last = 0;
    let match = regex.exec(body);
    while (match) {
      parts.push(body.slice(last, last + match.index));
      const username = match[0].slice(1);

      if (!mentions.has(username)) {
        try {
          const response = await get(url(`${config.source.api}/users/${username}`));
          const user = response.data;
          mentions.set(username, user.email);
        } catch (e) {
          // ignore, user does not exist
        }
      }

      const newName = config.destination.usernames[username];
      if (newName) {
        if (config.for_real) {
          parts.push(`@${newName}`);
        } else {
          parts.push(`\`@${newName}\``);
        }
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
  try {
    await destroy(config.destination.url, config.destination.admin_token);
  } catch (e) {
    warn(e);
  }
  progress("Creating destination repository");
  await post(url(`${config.destination.api}/orgs/${config.destination.repo.owner}/repos`),
             {name: config.destination.repo.name, private: true},
             config.destination.admin_token);
}

async function createPullComment(comment: PRComment): Promise<void> {
  const pullNumber = comment.pull_request_url.split("/").pop();
  progress(`Creating PR comment for PR #${pullNumber} (${comment.id})`);
  try {
    await post(url(`${config.destination.url}/pulls/${pullNumber}/comments`),
               {
                 body: `${comment.body}\n\n${suffix(comment)}`,
                 commit_id: comment.original_commit_id,
                 path: comment.path,
                 position: comment.original_position,
               },
               authorToken(comment.user));
  } catch (e) {
    if (e.response.status == 422 &&
        e.response.data.errors[0].message.endsWith("is not part of the pull request")) {
      warn(`Ignoring PR comment because the original commit is gone. (${comment.html_url})`);
      console.dir(comment);
    } else {
      throw e;
    }
  }
}

async function createCommitComment(comment: CommitComment): Promise<void> {
  progress(`Creating commit comment for ${comment.commit_id} (${comment.id})`);
  await post(url(`${config.destination.url}/commits/${comment.commit_id}/comments`),
             {
               body: `${comment.body}\n\n${suffix(comment)}`,
               commit_id: comment.commit_id,
               path: comment.path,
               position: comment.original_position,

             },
             authorToken(comment.user));
}

async function createIssueComment(comment: IssueComment): Promise<void> {
  const issueNumber = comment.issue_url.split("/").pop();
  progress(`Creating issue comment for #${issueNumber} (${comment.id})`);
  await post(url(`${config.destination.url}/issues/${issueNumber}/comments`),
             {
               body: `${comment.body}\n\n${suffix(comment)}`,
             },
             authorToken(comment.user));
}

async function createReview(review: Review): Promise<void> {
  progress(`Creating review ${review.html_url}`);
  const pr = review.pull_request_url.split("/").pop();
  const body = review.body.length > 0 
    ? `${review.body}\n\n${suffix(review)}`
    : suffix(review);
  try {
    if (review.event !== "COMMENT" || review.body.length > 0) {
      await post(url(`${config.destination.url}/pulls/${pr}/reviews`),
                 {
                   body: body,
                   event: review.event,
                 },
                 authorToken(review.user));
    } else {
      warn(`Ignoring review comment ${review.html_url}`);
    }
  } catch (e) {
    warn(`Error creating review :${e}`);
  }
}

async function createComments(comments: Comment[], missingCommits: Commit[]): Promise<void> {
  log("Creating comments");
  const missingHashes = new Set(missingCommits.map(c => c.sha));
  for (const comment of comments) {
    if (isPRComment(comment)) {
      if(!missingHashes.has(comment.original_commit_id)){
        await createPullComment(comment);
      }
    } else if (isCommitComment(comment)) {
      if (!missingHashes.has(comment.commit_id)) {
        await createCommitComment(comment);
      }
    } else if (isIssueComment(comment)) {
      await createIssueComment(comment);
    } else if (isReview(comment)) {
      await createReview(comment);
    } else {
      throw "Unknown comment type";
    }
  }
}

async function createLabels(labels: Label[]): Promise<void> {
  log("Creating labels");
  labels.push({
    name: "migrated",
    color: "ffffff",
    description: "This item originates from the migrated github.ugent.be repository",
  });
  for (const label of labels) {
    try {
      await post(url(`${config.destination.url}/labels`),
                 {
                   name: label.name,
                   color: label.color,
                   description: label.description,
                 },
                 config.destination.default_token);
    } catch (e) {
      if (e.response.status == 422) {
        warn(`Label ${label.name} already exists`);
      } else {
        throw e;
      }
    }
  }
}

async function createMilestones(milestones: Milestone[]): Promise<void> {
  log("Creating milestones");
  for (const milestone of milestones) {
    try {
      const data: any = {
        title: milestone.title,
        description: milestone.description,
        state: milestone.state,
      };
      if (milestone.due_on) {
        data.due_on = milestone.due_on;
      }

      await post(url(`${config.destination.url}/milestones`),
                 data,
                 config.destination.default_token);
    } catch (e) {
      if (e.response.status == 422) {
        warn(`Milestone ${milestone.title} already exists`);
      } else {
        throw e;
      }
    }
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
  await patch(url(`${config.destination.url}/issues/${issue.number}`),
              {
                labels: issue.labels
                  .map(label => label.name)
                  .concat(["migrated"]),
              },
              config.destination.default_token);
}

async function addMilestones(issue: Issue): Promise<void> {
  if(issue.milestone) {
    await patch(url(`${config.destination.url}/issues/${issue.number}`),
                {
                  milestone: issue.milestone.number
                },
                config.destination.default_token);
  }
}

function mergeUnmergeable(pull: PullRequest): void {
  const {head, base} = branchNames(pull);
  sh(`git -C ${cloneDir} fetch`);
  sh(`git -C ${cloneDir} checkout ${base}`);

  // Merge using the 'ours' strategy, which resolves conflicts for us
  const authorName = config.destination.committer_name;
  const authorEmail = config.destination.committer_email;
  sh(`GIT_COMMITTER_NAME="${authorName}" GIT_COMITTER_EMAIL="${authorEmail}" ` +
     `GIT_AUTHOR_NAME="${authorName}" GIT_AUTHOR_EMAIL="${authorEmail}" ` +
     `git -C ${cloneDir} merge origin/${head} -s ours --no-edit`);

  sh(`git -C ${cloneDir} push ${config.destination.repo.url} ${base}`);
  sh(`git -C ${cloneDir} checkout master`);
}

async function updatePull(pull: PullRequest): Promise<void> {
  progress(`Updating PR #${pull.number}`);
  await addLabels(pull);
  if (pull.merged) {
    progress(`Merging PR #${pull.number}`);
    try {
      await put(url(`${config.destination.url}/pulls/${pull.number}/merge`),
                {},
                authorToken(pull.closed_by));
    } catch (e) {
      if (e.response.status === 405) {
        warn("Unmergeable commit encountered, trying to merge manually...");
        mergeUnmergeable(pull);
      } else {
        throw e;
      }
    }
  } else if (pull.state === "closed") {
    await patch(url(`${config.destination.url}/pulls/${pull.number}`),
                {
                  state: pull.state,
                },
                authorToken(pull.closed_by));
  }
}

async function createReleases(releases: Release[]): Promise<void> {
  log("Creating releases");
  for (const release of releases) {
    progress(`Creating release ${release.name}`);
    await post(url(`${config.destination.url}/releases`),
               {
                 name: release.name,
                 tag_name: release.tag_name,
                 body: release.body,
                 draft: release.draft,
                 prerelease: release.prerelease,
               },
               authorToken(release.author));
  }
}

async function updateIssue(issue: Issue): Promise<void> {
  progress(`Updating issue #${issue.number}`);
  await addLabels(issue);
  await addMilestones(issue);
  if (issue.state === "closed") {
    await patch(url(`${config.destination.url}/issues/${issue.number}`),
                {
                  state: issue.state,
                },
                authorToken(issue.closed_by));
  }
}

async function updateIssuesAndPulls(issues: Issue[]): Promise<void> {
  log("Updating issues and pull requests");
  for (const issue of issues) {
    if (isPR(issue)) {
      await updatePull(issue);
    } else {
      await updateIssue(issue);
    }
  }
}

function cleanRemoteRepo(): void {
  log("Clean destination remote of temporary branches");
  sh(`git -C ${mirrorDir} push --mirror ${config.destination.repo.url}`);
}

(async () => {
  try {
    if (config.reset) {
      await resetDestination();
    }

    moveRepository();

    const issues = checkIfNeeded(issuePath)
      ? (await fetchIssues())
      : readJson<Issue[]>(issuePath);

    const comments = checkIfNeeded(commentPath)
      ? (await fetchComments(issues))
      : readJson<Comment[]>(commentPath);

    const labels = checkIfNeeded(labelsPath)
      ? (await fetchLabels())
      : readJson<Label[]>(labelsPath);

    const milestones = checkIfNeeded(milestonesPath)
      ? (await fetchMilestones())
      : readJson<Milestone[]>(milestonesPath);

    const releases = checkIfNeeded(releasesPath)
      ? (await fetchReleases())
      : readJson<Release[]>(releasesPath);

    const items = (issues as Authorable []).concat(comments);

    const missing = checkIfNeeded(missingPath)
      ? (await missingCommits(items))
      : readJson<Commit[]>(missingPath);

    if (missing.length > 0) {
      warn("Missing commits detected:");
      console.dir(missing);
    }

    await findCreators(items);
    await filterMentions(items);

    await createLabels(labels);
    await createMilestones(milestones);
    await createIssuesAndPulls(issues, missing);
    await createComments(comments, missing);

    await updateIssuesAndPulls(issues);
    await createReleases(releases);

    cleanRemoteRepo();

    await showRateLimit();
  } catch (e) {
    console.dir(e, {depth: 4});
    throw e;
  }
})();

