const logger = require('../../logger');
const config = require('config');
const common = require('./common');
const { sendToChannel, sendEphemeralMessage } = require('./message');
const { benchUserBySlackId, activateUserBySlackId, findBySlackUserId } = require('../users');

function challenge(req, res, next) {
  return res.send(req.body.challenge);
}

async function handleAdminCommands(command, theEvent, res) {
  if (!config.get('slack_manager_id') || config.get('slack_manager_id') !== theEvent.user) {
    return sendEphemeralMessage(theEvent.channel, theEvent.user, 'This command is Admin-only ');
  }

  if (command === 'overview') {
    logger.info(`[DM Event] ${theEvent.user} requested all users status`);
    return common.generateAndSendBootMessage(theEvent.channel);
  }

  if (command === 'shutdown') {
    logger.info(`[ADMIN Event] ${theEvent.uesr} requested shutdown`);
    return sendToChannel(theEvent.channel, 'Shutting down!')
      .then(() => {
        return process.exit(0);
      });
  }
}

async function handleDM(theEvent, res) {
  const smallText = theEvent.text.toLowerCase();
  res.sendStatus(200);
  if (smallText === 'stop' || smallText === 'silence' || smallText === 'mute') {
    logger.info(`[DM Event] ${theEvent.user} benched themselves.`);
    benchUserBySlackId(theEvent.user);
    return sendEphemeralMessage(theEvent.channel, theEvent.user,
      'You are now benched/muted/unrequestable :no_bell:');
  }
  if (smallText === 'start' || smallText === 'notify') {
    logger.info(`[DM Event] ${theEvent.user} activated themselves.`);
    activateUserBySlackId(theEvent.user);
    return sendEphemeralMessage(theEvent.channel, theEvent.user, 'You are now Requestable :bell:');
  }
  if (smallText === 'status') {
    const user = await findBySlackUserId(theEvent.user);
    logger.info(`[DM Event] ${theEvent.user} requested their status.`);
    return sendToChannel(theEvent.channel, `You are <@${user.slack.id}> here and ` +
    `<https://github.com/${user.github}|@${user.github}> on GitHub.\n` +
    `Your current Git Slackin' status is: ${user.requestable ? 'Requestable :bell:' : 'Silenced :no_bell:'}.`);
  }

  if (smallText === 'help') {
    return sendEphemeralMessage(theEvent.channel, theEvent.user, 'Here are my available commands:\n\n' +
    '`stop` or `silence` or `mute` -- No longer get requested for reviews. ' +
    'No longer get notifications when your PR is reviewed\n' +
    '`start` or `notify` -- Become requestable again\n' +
    '`status` -- get your current status/info that git slackin has about you');
  }

  const prplsRegex = new RegExp('^(prpls) (https://github.com/NewVistas/([\\w-])+/pull/(\\d)+)', 'i');
  if (prplsRegex.test(smallText)) {
    return sendToChannel(theEvent.channel, 'Sorry, I cannot currently add more reviewers');
  }

  return handleAdminCommands(smallText, theEvent, res);
}

function verify() {
  logger.warn('NOTE: we should verify this message');
}

function route(req, res, next) {
  verify();
  if (req.body.type === 'url_verification') return challenge(req, res, next);

  if (!req.body.event) {
    logger.error('Body missing event!');
    return res.sendStatus(200);
  }

  // logger.verbose(`[Slack Action] Received event: ${JSON.stringify(req.body, null, 2)}. Params: ${req.params}`);
  if (req.body.event.type === 'message' && req.body.event.subtype === 'bot_message') {
    logger.debug('Bots should not talk together');
    return res.sendStatus(200);
  }

  if (req.body.event.type === 'message' && !req.body.event.subtype && req.body.event.channel_type === 'im') {
    return handleDM(req.body.event, res);
  }

  logger.warn(`Event ${req.body.event.type} not handled`);
  return res.sendStatus(200);
}

module.exports = {
  route,
};
