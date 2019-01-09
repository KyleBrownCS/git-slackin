const appRoot = require('app-root-path');
const logger = require('../../logger');
const messenger = require('./message');
const simpleGit = require('simple-git/promise')(appRoot.path);
const users = require('../users');

async function generateAndSendBootMessage(channel = null, { msgText = null } = {}) {
  const { available, benched } = await users.listAllUserNamesByAvailability();
  const SHA = await simpleGit.revparse(['HEAD']);
  const messageObject = {
    text: msgText || `Git Slackin: ONLINE. SHA \`${SHA.trim()}\``,
    attachments: [
      {
        text: '',
        color: 'good',
        fields: [
          {
            title: 'Available Users',
            value: available,
          },
        ],
      },
      {
        text: '',
        color: 'warning',
        fields: [
          {
            title: 'Benched Users',
            value: benched,
          },
        ],
      },
    ],
  };

  if (channel && typeof channel === 'string') {
    return messenger.sendToChannel(channel, messageObject, { force: true });
  } else {
    logger.info(`Available Users: ${available}\nBenched Users: ${benched}`);
  }
}

function findUserMention(text) {
  const userMentions = /<@(\w+)>/gi.exec(text);
  if (!userMentions || userMentions.length === 0) {
    return null;
  }
  return userMentions[1].toUpperCase();
}

module.exports = {
  generateAndSendBootMessage,
  findUserMention,
};
