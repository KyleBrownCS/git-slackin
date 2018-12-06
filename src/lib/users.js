const appRoot = require('app-root-path');
const fs = require('fs');
const userListFilePath = `${appRoot}/user_list.json`;
const users = require(userListFilePath);

// Randomly select <numUsers> github users that are not <notMe>
async function selectRandomGithubUsersNot(notMe, numUsers = 1) {
  const usersToReturn = [];
  const excludedGithubNames = Array.isArray(notMe) ? notMe : [notMe];

  while (usersToReturn.length < numUsers) {
    // Select a random user that is not the one we passed based on github name
    const otherUsers = users.filter(current => {
      // Make sure its not themselves, and only people who are requestable
      return !excludedGithubNames.includes(current.github) && current.requestable;
    });
    if (otherUsers.length < 1) throw new Error('Not enough other users');

    const randomIndex = Math.floor(Math.random() * otherUsers.length);
    const selectedUser = otherUsers[randomIndex];
    usersToReturn.push(selectedUser);
    excludedGithubNames.push(selectedUser.github);
  }
  return usersToReturn;
}

// Look up a single user quickly
async function findByGithubName(name) {
  return users.find(element => element.github === name);
}

// Look up a single user quickly
async function findBySlackUserId(slackId) {
  return users.find(element => element.slack.id === slackId);
}

async function listBenchedUsers(onlyNames = false) {
  const filteredList = users.filter(user => !user.requestable);

  if (onlyNames) return filteredList.map(user => user.name);
  return filteredList;
}

async function listAvailableUsers(onlyNames = false) {
  const filteredList = users.filter(user => user.requestable);

  if (onlyNames) return filteredList.map(user => user.name);
  return filteredList;
}

async function listAllUsers() {
  return users;
}

async function benchUserBySlackId(id) {
  users.map(user => {
    if (user.slack.id === id) {
      user.requestable = false;
    }
    return user;
  });
  fs.writeFileSync(userListFilePath, JSON.stringify(users, null, 2), 'utf-8');
  return users;
}

async function activateUserBySlackId(id) {
  users.map(user => {
    if (user.slack.id === id) {
      user.requestable = true;
    }
    return user;
  });

  fs.writeFileSync(userListFilePath, JSON.stringify(users, null, 2), 'utf-8');
  return users;
}

module.exports = {
  selectRandomGithubUsersNot,
  findByGithubName,
  findBySlackUserId,
  listAllUsers,
  listBenchedUsers,
  listAvailableUsers,
  benchUserBySlackId,
  activateUserBySlackId,
};
