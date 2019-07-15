#!/usr/bin/env node

const rest = require("unirest");
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

function invoke(method, url, data, callback, token) {
  const request = method(url)
    .type("json")
    .headers({
      "Authorization": "token " + (token || config.source.token),
      "User-Agent": "node.js",
    });

  if (data) {
    request.send(data);
  }

  request.end(response => {
    if (response.error) {
      console.log(`Error making call to ${url} with data:`);
      console.dir(data);
      console.log("Error:");
      console.dir(response.error);
    }
    callback(response.error, response.body);
  });
}

function get(url, callback, token) {
  invoke(rest.get, url, null, callback, token);
}

function post(url, data, callback, token) {
  invoke(rest.post, url, data, callback, token);
}

function fetchNextIssue(issueNumber, callback) {
  const writeIssue = issue => {
    fs.writeFileSync(`${issueDir}/issue${issueNumber}.json`,
      JSON.stringify(issue, null, 2));
  };

  get(`${config.source.repoUrl}/issues/${issueNumber}`,
    (err, issue) => {
      if (err) {
        callback();
      } else if (issue.pull_request) {
        // This issue is a pull request, fetch base and head
        get(`${config.source.repoUrl}/pulls/${issueNumber}`,
          (_, pull) => {
            issue.base = pull.base;
            issue.head = pull.head;
          });
        writeIssue(issue);
      } else {
        writeIssue(issue);
      }
    });
}

fetchNextIssue(1);

const url = config.destination.repoUrl + "/issues";
const data = {
  "title": "test issue",
  "body": "test issue aangemaakt om tokens te testen",
};

// post(url, data, () => {}, config.destination.tokens["fvdrjeug"]);


