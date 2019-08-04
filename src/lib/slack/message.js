const { WebClient } = require('@slack/client');
const config = require('config');
const { findBySlackUserId } = require('../users');
const logger = require('../../logger');

// Setup Slack web client
const token = config.get('slack');
const web = new WebClient(token);

function buildParams(conversationId, message) {
  if (typeof process.env.DEBUG === 'string') {
    logger.debug(`[DEBUG] conversationId: ${conversationId}, Message: ${message}`);
  }
  if (typeof message === 'string' && !message.trim()) throw new Error('Message must be a non-zero length string.');
  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    throw new Error('Message must be a non-zero length string.');
  }

  let params = { channel: conversationId };

  if (typeof message === 'object') {
    params = Object.assign(params, message);
  } else {
    params.text = message;
  }

  if (typeof process.env.DEBUG === 'string') {
    logger.debug(`[DEBUG] Message: ${JSON.stringify(params, null, 2)}`);
  }
  return params;
}

// TODO: Make smarter sendMessage functions
// One for fields
// One for basic
// One for buttons
// Actually send a message
function sendMessage(conversationId, message) {
  const params = buildParams(conversationId, message);
  // See: https://api.slack.com/methods/chat.postMessage
  return web.chat.postMessage(params)
    .then((res) => {
      logger.info(`[Messenger] Sent to ${conversationId}. Timestamp: ${res.ts}`);
      return res;
    })
    .catch(e => {
      logger.error(e);
      throw e;
    });
}

function sendEphemeralMessage(conversationId, userId, message) {
  const params = buildParams(conversationId, message);
  params.user = userId;

  // See: https://api.slack.com/methods/chat.postMessage
  return web.chat.postEphemeral(params)
    .then((res) => {
      logger.info(`[Messenger] Sent to ${conversationId}. Timestamp: ${res.ts}`);
      return res;
    })
    .catch(e => {
      logger.error('EPHEMERAL ERROR:');
      logger.error(e);
      // throw e;
    });
}

// TODO: Should be smarter and check if it's open first?
function openDM(userId) {
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('Must provider userId');
  return web.conversations.open({ users: userId })
    .then(res => {
      if (res.ok) {
        return res.channel.id;
      } else {
        throw new Error(res.error);
      }
    });
}

// allows for more complicated checks in the future
async function silenced(user) {
  return (!user || user.notifications === false);
}

// have to find the DM channel ID, then send a message on that channel.
// just using the user ID sends the message via @slackbot instead.
async function sendDM(userId, message, { force = false } = {}) {
  const user = await findBySlackUserId(userId);
  const cannotSend = await silenced(user);
  if (cannotSend && !force) return logger.info(`[DM] Shh ${user.name} should not be bothered`);

  return openDM(userId)
    .then(dmChannelId => {
      return sendMessage(dmChannelId, message);
    });
}


module.exports = {
  send: sendDM,
  sendToChannel: sendMessage,
  sendEphemeralMessage,
  openDM,
};
