const users = require('../users');
const logger = require('../../logger');
const messenger = require('./message');

async function generateAndSendBootMessage(channel = null, { msgText = null } = {}) {
  const { available, benched } = await users.listAllUserNamesByAvailability();

  const messageObject = {
    text: msgText || 'Git Slackin: ONLINE',
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

module.exports = {
  generateAndSendBootMessage,
};
