const shortid = require('shortid');
const logger = require('../../logger');
const config = require('config');
const common = require('./common');
const { sendToChannel, sendEphemeralMessage, send } = require('./message');
const { benchUserBySlackId, activateUserBySlackId, findByGithubName, findBySlackUserId,
  muteNotificationsBySlackId, unmuteNotificationsBySlackId, createUser } = require('../users');
const appRoot = require('app-root-path');
const fs = require('fs');
const configFile = `${appRoot}/config/development.json`;
const configuration = require(configFile);
const simpleGit = require('simple-git/promise')(appRoot.path);

function challenge(req, res, next) {
  logger.info(`Slack Challenge: ${JSON.stringify(req.body)}`);
  return res.status(200).type('text/plain').send(req.body.challenge);
}


async function updateConfigurations(configOverrides) {
  const mergedConfigs = Object.assign(configuration, configOverrides);
  return fs.writeFileSync(configFile, JSON.stringify(mergedConfigs, null, 2), 'utf-8');
}

// TODO: Fix this error
//Git#then is deprecated after version 1.72 and will be removed in version 2.x
//Please switch to using Git#exec to run arbitrary functions as part of the command chain.

// maybe I should just fetch and checkout the branch instead of pulling I think this would allow for better updates
// especially if changing branches.
async function updateGitSlackin(theEvent, branch = 'master') {
  let updateResult = null;
  try {
    // Let's discard these changes first.
    await simpleGit.stash();
    await simpleGit.stash(['drop']);

    // Now let's grab the latest and always take the origin's changes
    // Rebase to avoid extra commits. Thanks Oh-my-zsh for the inspiration!
    updateResult = await simpleGit.pull('origin', branch, { '--rebase': 'true' });
  } catch (e) {
    return sendEphemeralMessage(theEvent.challenge, theEvent.user.slack, `Update failed. Error: ${e}`);
  }

  const triggeringUser = await findBySlackUserId(theEvent.user);
  return sendToChannel(theEvent.channel, `Update trigger by ${triggeringUser.name}. Be back shortly! :wave:\n` +
  `Changes: ${updateResult}`)
    .then(() => {
      // this works since we've already pulled so restarting should work.
      return process.exit(0);
    });
}

async function handleAdminCommands(command, theEvent, res, logId) {
  if (!config.has('slack_manager_ids')
    || !config.get('slack_manager_ids').includes(theEvent.user)) {
    return sendEphemeralMessage(theEvent.channel, theEvent.user, 'This command is Admin-only or does not exist.');
  }

  if (/^echo/.test(command)) {
    logger.info('[Admin] echo requested');
    return sendToChannel(theEvent.channel, `\`\`\`${command}\n${JSON.stringify(theEvent)}\`\`\``);
  }

  if (/^config$/.test(command)) {
    return sendEphemeralMessage(theEvent.channel, theEvent.user, JSON.stringify(configuration));
  }

  const setConfigRegexResult = /^config set (.+)$/.exec(command);
  if (setConfigRegexResult && setConfigRegexResult.length > 1) {
    try {
      const newConfig = JSON.parse(setConfigRegexResult[1]);
      await updateConfigurations(newConfig);
      return await sendToChannel(theEvent.channel, 'Updated config, restarting Git Slackin...')
        .then(() => {
          return process.exit(0);
        });
    } catch (e) {
      return sendEphemeralMessage(theEvent.channel, theEvent.user, 'Error updating configuration');
    }
  }

  if (command === 'overview') {
    logger.info(`[DM Event] ${theEvent.user} requested all users status`);
    return common.generateAndSendBootMessage(theEvent.channel);
  }

  if (/^bench/.test(command)) {
    const slackUserIdToBench = common.findUserMention(command);
    if (!slackUserIdToBench) {
      logger.warn(`[commands.admin.bench:${logId}] Could not find user to user ${slackUserIdToBench}`);

      return await sendEphemeralMessage(theEvent.channel, theEvent.user,
        `:whatsgoingon: I could not find the user '<@${slackUserIdToBench}>' to bench. ` +
        `Please inform James if you think this is a bug. And refer to log code: \`${logId}\``);
    }

    const success = await benchUserBySlackId(slackUserIdToBench, logId);

    if (success) {
      await send(slackUserIdToBench, `You have been benched by <@${theEvent.user}>. ` +
      'Send me, Git Slackin, `start` to start receiving Review Requests again.');

      return await sendEphemeralMessage(theEvent.channel, theEvent.user,
        `I have benched <@${slackUserIdToBench}> as requested.`);
    } else {
      const logId = shortid.generate();
      logger.warn(`[commands.admin.bench:${logId}] Could not bench user ${slackUserIdToBench}`);

      return await sendEphemeralMessage(theEvent.channel, theEvent.user,
        `:whatsgoingon: I could not bench <@${slackUserIdToBench}> as requested. ` +
        `Please inform James if you think this is a bug. And refer to log code: \`${logId}\``);
    }
  }

  if (/^unbench/.test(command)) {
    const slackUserIdToUnbench = common.findUserMention(command);
    if (!slackUserIdToUnbench) {
      logger.warn(`[commands.admin.bench:${logId}] Could not find user to user ${slackUserIdToUnbench}`);

      return await sendEphemeralMessage(theEvent.channel, theEvent.user,
        `:whatsgoingon: I could not find the user '<@${slackUserIdToUnbench}>' to unbench. ` +
        `Please inform James if you think this is a bug. And refer to log code: \`${logId}\``);
    }

    const success = await activateUserBySlackId(slackUserIdToUnbench, logId);

    if (success) {
      send(slackUserIdToUnbench, `You have been unbenched by <@${theEvent.user}>. ` +
      'Send me, Git Slackin, `start` to start receiving Review Requests again.');

      return sendEphemeralMessage(theEvent.channel, theEvent.user,
        `I have unbenched <@${slackUserIdToUnbench}> as requested.`);
    } else {
      const logId = shortid.generate();
      logger.warn(`[commands.admin.unbench:${logId}] Could not unbench user: ${slackUserIdToUnbench}`);

      return await sendEphemeralMessage(theEvent.channel, theEvent.user,
        `:whatsgoingon: I could not unbench <@${slackUserIdToUnbench}> as requested. ` +
        `Please inform James if you think this is a bug. And refer to log code: \`${logId}\``);
    }
  }

  // This looks for update either by itself or followed by a space then another word (the branch name)
  const updateRegexResult = /^update(?:\s(\w+))?$/.exec(command);
  if (updateRegexResult && updateRegexResult.length > 1) {
    const branch = updateRegexResult[1]; // will be undefined if not found and that's fine
    logger.info(`[DM Event] ${theEvent.user} is updating to the latest version`);
    return await updateGitSlackin(theEvent, branch);
  }

  if (command === 'shutdown') {
    logger.info(`[ADMIN Event] ${theEvent.user} requested shutdown`);
    return sendToChannel(theEvent.channel, 'Shutting down!')
      .then(() => {
        return process.exit(0);
      });
  }
}

async function handleCommands(text, theEvent, res, logId = 'NoId') {
  const smallText = text.toLowerCase();

  if (/^register/.test(smallText)) {
    logger.info(`[DM Event] Registration Begin: ${theEvent.user}`);
    const registerRegexResult = /^register(?:\s(.+))?$/.exec(smallText);
    const githubUserRegex = /http[s]*:\/\/github.com\/([a-zA-Z-]+)\//g;

    if (registerRegexResult && registerRegexResult.length === 2) {
      const githubRegexResults = githubUserRegex.exec(registerRegexResult[1]);

      // Grab the username, either from the URL or directly
      let githubUserName = registerRegexResult[1];
      if (githubRegexResults && githubRegexResults.length === 2) {
        githubUserName = githubRegexResults[1];
      }

      const preexistingUser = await findByGithubName(githubUserName, logId);

      if (preexistingUser !== null) {
        const preexistingUserSlackName = preexistingUser.slack ? preexistingUser.slack.name : 'SOMEONE';

        logger.error(`[commands.user.register:${logId}] Cannot register twice! ${preexistingUser.github} ` +
          `is already registered to ${preexistingUserSlackName}`);
        return sendToChannel(theEvent.channel, 'Registration failed.' +
          ' That github username is already registered to someone else. (Weird!)' +
          ` If you think this incorrect, please message James and refer to log code: ${logId}`);
      }

      // TODO: look up more info about slack user when I update from slack sdk v4 to v5
      // Change first param to name based on looked up slack info
      return await createUser(githubUserName, { name: githubUserName, id: theEvent.user }, githubUserName) // TODO: Grab all needed info
        .then(() => {
          logger.info(`[commands.user.register:${logId}]`);
          return sendToChannel(theEvent.channel, 'You are now registered, now git slackin\'!');
        });
    } else {
      logger.error(`[commands.user.register:${logId}] Registration Failed: no username specified.`);
      return sendToChannel(theEvent.channel, 'Registration failed, github username not specified. ' +
      `If you think this is due to a bug, please message James and refer to log code: ${logId}`);
    }
  }

  if (smallText === 'ping') {
    logger.info(`[commands.user.ping:${logId}] ${theEvent.user} is playing ping-pong`);
    return sendToChannel(theEvent.channel, 'pong :table_tennis_paddle_and_ball:');
  }

  if (smallText === 'marco') {
    logger.info(`[commands.user.marco:${logId}] ${theEvent.user} is looking for Marco`);
    return sendToChannel(theEvent.channel, 'Polo! :water_polo:');
  }

  if (smallText === 'hello' || smallText === 'hi') {
    logger.info(`[commands.user.hello:${logId}] ${theEvent.user} is trying to converse with a robot.`);
    return sendEphemeralMessage(theEvent.channel, theEvent.user,
      'Hey.');
  }

  if (smallText === 'stop') {
    logger.info(`[commands.user.stop:${logId}] ${theEvent.user} benched themselves.`);
    const success = benchUserBySlackId(theEvent.user, logId);
    if (success) {
      return sendEphemeralMessage(theEvent.channel, theEvent.user,
        'You are now benched and are unrequestable :no:');
    } else {
      return sendEphemeralMessage(theEvent.channel, theEvent.user,
        `:thisisfine: An error has occurred. Message James and refer to log code: ${logId}`);
    }
  }

  if (smallText === 'silence' || smallText === 'mute') {
    logger.info(`[commands.user.notifications.off:${logId}] ${theEvent.user} turned off notifications`);
    muteNotificationsBySlackId(theEvent.user, logId); // TODO: Mimic benchuserBySlackId
    return sendEphemeralMessage(theEvent.channel, theEvent.user,
      'Your Git Slackin notifications are now muted :no_bell:');
  }

  if (smallText === 'notify' || smallText === 'unmute') {
    logger.info(`[command.user.notification.on:${logId}] ${theEvent.user} turned on notifications`);
    unmuteNotificationsBySlackId(theEvent.user, logId); // TODO: Mimic benchuserBySlackId
    return sendEphemeralMessage(theEvent.channel, theEvent.user,
      'Your Git Slackin notifications are now unmuted :bell:');
  }

  if (smallText === 'start') {
    logger.info(`[commands.user.unbench:${logId}] ${theEvent.user} Attempting to activate themselves.`);
    const success = activateUserBySlackId(theEvent.user);
    if (success) {
      logger.info(`[commands.user.unbench:${logId}] ${theEvent.user} activated themselves.`);
      return sendEphemeralMessage(theEvent.channel, theEvent.user, 'You are now Requestable :yes:');
    } else {
      logger.error(`[commands.user.unbench:${logId}] ${theEvent.user} could not acivate themselves.`);
      return sendEphemeralMessage(theEvent.channel, theEvent.user,
        ':thisisfine: Something went wrong and you are still benched. ' +
        'Please message James and refer to log code ' +
        `${logId} if you think this is a bug.`);
    }
  }
  if (smallText === 'status') {
    const user = await findBySlackUserId(theEvent.user);
    logger.info(`[commands.user.status:${logId}] ${theEvent.user} requested their status.`);
    return sendEphemeralMessage(theEvent.channel, theEvent.user, `You are <@${user.slack.id}> here and ` +
    `<https://github.com/${user.github}|@${user.github}> on GitHub.\n` +
    `Your current Git Slackin' status is: ${user.requestable ? 'Requestable :yes:' : 'UnRequestable :no:'}.\n` +
    `Your current Git Slackin' notification mode is: ${user.notifications ? 'On :bell:' : 'Off :no_bell:'}`);
  }

  if (smallText === 'help') {
    // TODO! Update this
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

  return handleAdminCommands(smallText, theEvent, res, logId);
}

async function handleDM(theEvent, res, logId) {
  return await handleCommands(theEvent.text, theEvent, res, logId);
}

function verify() {
  logger.warn('NOTE: we should verify this message');
}

function route(req, res, next) {
  const logId = shortid.generate();
  verify();
  if (req.body.type === 'url_verification') return challenge(req, res, next);

  if (!req.body.event) {
    logger.error(`[slack.route:${logId}] Body missing event!`);
    return res.sendStatus(200);
  }
  res.sendStatus(200);


  // logger.verbose(`[Slack Action] Received
  if (req.body.event.type === 'message' && !req.body.event.subtype && req.body.event.channel_type === 'im') {
    console.log(req.body.event);
    return handleDM(req.body.event, res, logId);
  } else if (req.body.event.type === 'message') {
    return logger.warn(`[slack.route.unhandled:${logId}] Subtype: '${req.body.event.subtype}' Channel type: '${req.body.event.channel_type}'`);
  }

  if (req.body.event.type === 'app_mention') {
    const mentions = /^<@\w+> (.+)$/g;
    const matches = mentions.exec(req.body.event.text);
    if (matches && matches.length >= 2) {
      return handleCommands(matches[1], req.body.event, res);
    } else {
      logger.warn(`[slack.route.badparse:${logId}] App_mention did not split nicely`);
    }
  }

  logger.warn(`[slack.route.noroute:${logId}] Event ${req.body.event.type} not handled`);
}

module.exports = {
  route,
};
