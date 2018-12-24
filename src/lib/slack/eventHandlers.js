const logger = require('../../logger');
const config = require('config');
const common = require('./common');
const { sendToChannel, sendEphemeralMessage, send } = require('./message');
const { benchUserBySlackId, activateUserBySlackId, findBySlackUserId } = require('../users');

function challenge(req, res, next) {
  return res.send(req.body.challenge);
}

const appRoot = require('app-root-path');
const simpleGit = require('simple-git')(appRoot);

async function updateGitSlackin(theEvent) {
  let updateResult = null;
  try {
    updateResult = await simpleGit.pull();
  } catch (e) {
    return sendEphemeralMessage(theEvent.challenge, theEvent.user.slack, `Update failed. Error: ${e}`);
  }

  return sendToChannel(theEvent.channel, `Update trigger by ${theEvent.user.name}. Be back shortly! :wave:\n` +
  `Changes: ${updateResult}`)
    .then(() => {
      // this works since we've already pulled so restarting should work.
      return process.exit(0);
    });
}

async function handleAdminCommands(command, theEvent, res) {
  if (!config.get('slack_manager_id') || config.get('slack_manager_id') !== theEvent.user) {
    return sendEphemeralMessage(theEvent.channel, theEvent.user, 'This command is Admin-only ');
  }

  if (command === 'overview') {
    logger.info(`[DM Event] ${theEvent.user} requested all users status`);
    return common.generateAndSendBootMessage(theEvent.channel);
  }

  const benchUserRegex = /bench <@(\w+)>/gi; // new RegExp('bench <@\w+>', 'i');

  if (benchUserRegex.test(command)) {
    const regexResult = benchUserRegex.exec(command);
    if (!regexResult || regexResult.length < 2) return logger.warn('No user found');
    const slackUserIdToBench = regexResult[1];
    await benchUserBySlackId(slackUserIdToBench);
    send(slackUserIdToBench, `You have been benched by ${theEvent.user}. ` +
    'Send me, Git Slackin, `start` to start receiving Review Requests again.');
    sendEphemeralMessage(theEvent.channel, theEvent.user, `I have benched <@${slackUserIdToBench}> as requested.`);
  }

  if (command === 'update') {
    logger.info(`[DM Event] ${theEvent.user} is updating to the latest version`);
    return await updateGitSlackin(theEvent);
  }

  if (command === 'shutdown') {
    logger.info(`[ADMIN Event] ${theEvent.uesr} requested shutdown`);
    return sendToChannel(theEvent.channel, 'Shutting down!')
      .then(() => {
        return process.exit(0);
      });
  }
}

async function handleCommands(text, theEvent, res) {
  const smallText = text.toLowerCase();

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
    return sendEphemeralMessage(theEvent.channel, theEvent.user, `You are <@${user.slack.id}> here and ` +
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

  // Looks for PR form
  const prplsRegex = new RegExp('^(prpls) (<https://github.com/\\w+/([\\w])+/pull/(\\d)+>)', 'i');
  if (prplsRegex.test(smallText)) {
    return sendEphemeralMessage(theEvent.channel, theEvent.user, 'Sorry, I cannot currently add more reviewers');
  }

  return handleAdminCommands(smallText, theEvent, res);
}

async function handleDM(theEvent, res) {
  return await handleCommands(theEvent.text, theEvent, res);
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
  res.sendStatus(200);


  // logger.verbose(`[Slack Action] Received event: ${JSON.stringify(req.body, null, 2)}. Params: ${req.params}`);
  if (req.body.event.type === 'message' && req.body.event.subtype === 'bot_message') {
    logger.debug('Bots should not talk together');
  }

  if (req.body.event.type === 'message' && !req.body.event.subtype && req.body.event.channel_type === 'im') {
    console.log(req.body.event);
    return handleDM(req.body.event, res);
  }

  if (req.body.event.type === 'app_mention') {
    const mentions = /^<@\w+> (.+)$/g;
    const matches = mentions.exec(req.body.event.text);
    if (matches && matches.length >= 2) {
      return handleCommands(matches[1], req.body.event, res);
    } else {
      logger.warn('App_mention did not split nicely');
    }
  }

  logger.warn(`Event ${req.body.event.type} not handled`);
}

module.exports = {
  route,
};
