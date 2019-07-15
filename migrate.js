#!/usr/bin/env node

const axios = require("axios");
const fs = require("fs");
const yaml = require("js-yaml");
const program = require("commander");

program.version("0.1.0")
  .option("-c, --config <path>",
    "Configuration file path. Defaults to ./config.yml");

const configFile = program.config || "./config.yml";
const config = yaml.safeLoad(fs.readFileSync(configFile));

config.destination.repoUrl = config.destination.url + "/repos/" +
  config.destination.owner + "/" + config.destination.repository;

config.source.repoUrl = config.source.url + "/repos/" +
  config.source.owner + "/" + config.source.repository;

const repoDir = "data/" + config.destination.repository;
const issueDir = repoDir + "/issues/";
fs.mkdirSync(issueDir, {recursive: true});

function invoke(method, url, data, token) {
  return axios({
    method: method,
    url: url,
    data: data,
    headers: {
      "Authorization": "token " + (token || config.source.token),
      "User-Agent": "node.js",
    },
  });
}

function get(url, token) {
  return invoke("get", url, null, token);
}

function patch(url, data, token) {
	invoke("patch", url, data, token);
}

function post(url, data, token) {
  return invoke("post", url, data, token);
}

/**
 * Call callback with an increasing integer and awaits the result. Continues
 * until an exception is thrown.
 * TODO: untilNull
 */
async function untilErr(callback, start) {
  try {
    let i = start || 0;
    while(true) {
      await callback(i);
      i += 1;
    }
  } catch (err) {
    console.log(err);
  }
}

async function fetchIssue(issueNumber) {
  console.log(`Fetching issue ${issueNumber}`);
  const request = await get(`${config.source.repoUrl}/issues/${issueNumber}`);
  const issue = request.data;
  if (issue.pull_request) {
    const pull = await get(`${config.source.repoUrl}/pulls/${issueNumber}`);
    issue.base = pull.data.base;
    issue.head = pull.data.head;
  }
  fs.writeFileSync(`${issueDir}/issue${issueNumber}.json`,
                   JSON.stringify(issue, null, 2));
}

async function fetchAllIssues() {
  await untilErr(fetchIssue, 1);
}

async function fetchCommentPage(type, page) {
  const response = await get(`${config.source.repoUrl}/${type}?page=${page}&state=all&per_page=100`);
  debugger;
  if (response.data.length === 0){
      throw "all comments fetched";
  }
  return response.data;
}

async function fetchCommentsOfType(type) {
  let comments = [];
  console.log(`Fetching ${type}`);
  await untilErr(async i => {
    let page = await fetchCommentPage(type, i);
    comments = comments.concat(page);
  });
  return comments;
}

async function fetchAllComments() {
  const pull_comments = await fetchCommentsOfType("pulls/comments");
  const issues_comments = await fetchCommentsOfType("issues/comments");
  const commit_comments = await fetchCommentsOfType("comments");
  const comments = []
    .concat(pull_comments)
    .concat(issues_comments)
    .concat(commit_comments)
    .sort((a, b) => a.created_at - b.created_at);
  fs.writeFileSync(`${repoDir}/comments.json`,
                   JSON.stringify(comments, null, 2));
}

function readIssues() {
  return fs.readdirSync(issueDir)
    .map(file => JSON.parse(fs.readFileSync(issueDir + "/" + file)))
    .sort((a, b) => a.number - b.number);
}

function readComments() {
  return JSON.parse(fs.readFileSync(repoDir + "/comments.json"));
}

async function commitExists(sha) {
  const url = config.destination.repoUrl + '/git/commits/' + commit;
  try {
    await get(url, config.destination.default_token);
    return true;
  } catch (err) {
    return false;
  }
}

function missingCommits(issues, comments) {
  return issues
    .concat(comments)
    .map(item => {
      if (item.base) { // Pull Request
        return {url: item.url, sha: item.base.sha };
      } else if (item.pull_request_url) { // Review comment
        return {url: item.url, sha: item.original_commit_id };
      } else if (item.commit_id) { // Commit comment
        return {url: item.url, sha: item.commit_id };
      }
    }).filter(item => item !== undefined && !commitExists(item.sha));
}


//fetchAllIssues()
//  .then(fetchAllComments)
//  .then(() => console.log("Completed"));

const issues = readIssues();
const comments = readComments();
console.log(missingCommits(issues, comments));

/*const url = config.destination.repoUrl + "/issues";
const data = {
  "title": "test issue",
  "body": "test issue aangemaakt om tokens te testen",
};

post(url, data, () => {}, config.destination.tokens["fvdrjeug"]);
*/


