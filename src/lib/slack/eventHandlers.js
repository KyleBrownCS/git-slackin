const logger = require('../../logger');
const { sendToChannel } = require('./message');
const { benchUserBySlackId, activateUserBySlackId, findBySlackUserId } = require('../users');

function challenge(req, res, next) {
  return res.send(req.body.challenge);
}


async function handleDM(theEvent, res) {
  if (theEvent.text === 'STOP') {
    benchUserBySlackId(theEvent.user);
    return res.sendStatus(200);
  }
  if (theEvent.text === 'START') {
    activateUserBySlackId(theEvent.user);
    return res.sendStatus(200);
  }
  if (theEvent.text === 'STATUS') {
    const user = await findBySlackUserId(theEvent.user);
    res.sendStatus(200);
    return sendToChannel(theEvent.channel, `You are <@${user.slack.id}> here and ` +
    `<https://github.com/${user.github}|@${user.github}> on GitHub.\n` +
    `Your current Git Slackin' status is: ${user.requestable ? 'Requestable' : 'Silenced'}.`);
  }
  return res.sendStatus(200);
}

function verify() {
  logger.warn('NOTE: we should verify this message');
}

function route(req, res, next) {
  verify();
  if (req.body.event.type === 'message' && req.body.event.subtype === 'bot_message') {
    logger.debug('Bots should not talk together');
    return res.sendStatus(200);
  }
  logger.info(`[Slack Action] Received event: ${JSON.stringify(req.body, null, 2)}. Params: ${req.params}`);
  if (req.body.type === 'url_verification') return challenge(req, res, next);

  if (req.body.event.type === 'message' && !req.body.event.subtype && req.body.event.channel_type === 'im') {
    return handleDM(req.body.event, res);
  }

  logger.warn('Event not handled');
  return res.sendStatus(200);
}

module.exports = {
  route,
};
