const octokit = require('@octokit/rest')();
const config = require('config');
const shortid = require('shortid');

// My Modules
const logger = require('../../logger');
const { selectRandomGithubUsers, findByGithubName, filterUsers } = require('../users');
const { send } = require('../slack/message');

// Number of reviewers required for our workflow. Could move to config eventually.
const NUM_REVIEWERS = 2;

// authenticate with Github
octokit.authenticate({
  type: 'token',
  token: config.get('github_token'),
});

function sendReviewRequestMessage(openerName, user, body) {
  logger.info(`[Review Request Message] Send to ${user.name}`);
  if (!user || !user.slack) {
    logger.warn('[Review Request Message] No user to send message to');
    return Promise.reject('No Slack ID to sent message to');
  }

  const conversationId = user.slack.id;

  const message = 'Hi! Please look at ' +
  `<${body.pull_request.html_url}|${body.pull_request.base.repo.name} PR #${body.number}> ` +
  `"${body.pull_request.title}" that ${openerName} opened.`;
  const msgObj = {
    text: message,
    attachments: [
      {
        text: 'Hacky workaround will remove message',
        callback_id: 'ISetACallbackId',
        actions: [
          {
            name: 'todo',
            text: 'Remove this message',
            type: 'button',
            value: 'testValue',
          },
        ],
      },
    ],
  };

  return send(conversationId, msgObj);
}

async function sendOpenerInitialStateMessage(opener, reviewers, prObj) {
  if (!opener.slack) return logger.warn('[PR Opened] No slack user to message');
  const conversationId = opener.slack.id;
  const reviewersNames = reviewers.map(user => `<@${user.slack.id}>`);
  const message = `You opened <${prObj.html_url}|PR #${prObj.number}> ` +
  `\`${prObj.title.replace('`', '\\`')}\`, on ${prObj.base.repo.name}.\n` +
  ':spiral_note_pad: If you\'re in the office :office: today, give these people Post-Its!\n' +
  '(If you\'re working remote :house:, don\'t worry. I\'ll still send them a message.):';

  const msgObj = {
    text: message,
    attachments: [
      {
        fields: [
          {
            title: 'Reviews Requested',
            value: reviewersNames.join(' '),
            short: true,
          },
        ],
      },
    ],
  };
  return send(conversationId, msgObj);
}

async function requestReviewersAndAssignees(users, body) {
  try {
    const githubUsers = users.map(user => user.github);

    // Should probably look at the results to check if reviewers are there.
    const reviewRequests = await octokit.pullRequests.createReviewRequest({
      owner: body.pull_request.base.repo.owner.login,
      repo: body.pull_request.base.repo.name,
      number: body.pull_request.number,
      reviewers: githubUsers,
    });

    const assignees = await octokit.issues.addAssignees({
      owner: body.pull_request.base.repo.owner.login,
      repo: body.pull_request.base.repo.name,
      number: body.pull_request.number,
      assignees: githubUsers,
    });

    logger.info(`[Add Users to PR] Repo: ${body.pull_request.base.repo.name}. ` +
    `Assigned and Request reviews from: ${githubUsers}`);
    return [reviewRequests, assignees];
  } catch (e) {
    logger.error(`Error: ${e}`);
    throw e;
  }
}

async function requestReviewByGithubName(body) {
  const logId = shortid.generate();
  const opener = await findByGithubName(body.pull_request.user.login, logId);
  const openerName = opener ? opener.name : body.pull_request.user.login;
  const requestedReviewer = await findByGithubName(body.requested_reviewer.login, logId);
  if (requestedReviewer && requestedReviewer.slack) {
    return await sendReviewRequestMessage(openerName, requestedReviewer, body);
  }
  return logger.warn(`[github.requestReviewByGithubName:${logId}] Cannot find user`);
}

// Handle everything we want to do about opening a PR.
// v1: randomly pick 2 users and send them links on Slack
async function prOpened(body) {
  const logId = shortid.generate();
  try {
    // TODO: Have findByGithubName fail better if it can't find the person
    const opener = await findByGithubName(body.pull_request.user.login, logId);
    const wipRegex = /^\[*\s*WIP\s*\]*\s+/gi;
    if (wipRegex.test(body.pull_request.title) && opener) {
      return send(opener,
        `Are you sure you meant to open PR <${body.pull_request.html_url}|${body.pull_request.title}>? ` +
        'You marked it Work in Progress. So I will ignore it');
    }

    // NOTE: This uses assignees because requested reviewers come back in separate events
    const numReviewersAlready = body.pull_request.assignees.length;
    const numReviewersToRandomlySelect = NUM_REVIEWERS - numReviewersAlready;

    const preselectedUsers = await Promise.all(body.pull_request.assignees.map(user => {
      return findByGithubName(user.login, logId);
    }));
    const notTheseUsers = opener ? preselectedUsers.concat(opener.github) : preselectedUsers;
    const randomUsers = await selectRandomGithubUsers(notTheseUsers, numReviewersToRandomlySelect);
    const users = preselectedUsers.concat(randomUsers);

    // TODO: Handle it better if either fails
    await requestReviewersAndAssignees(randomUsers, body);
    if (opener) {
      await sendOpenerInitialStateMessage(opener, users, body.pull_request);
    }

    const openerName = opener ? opener.name : body.pull_request.user.login;
    return logger.info(`[github.prOpened:${logId}] Opener: ${openerName} Reviewers Messaged: ${users.map(user => user.name)}`);
  } catch (e) {
    logger.error(`[github.prOpened:${logId}] Error: ${e}`);
    throw e;
  }
}

async function notifyMergers(msg) {
  const mergers = await filterUsers({ prop: 'merger', val: true });
  const promises = mergers.map(user => send(user.slack.id, msg));
  return await Promise.all(promises);
}

// Check if the PR is all approved by the right number of people
async function checkForReviews({ owner, repo, number }) {
  // grab all the reviews (listed chronologically)
  const allReviews = await octokit.pullRequests.listReviews({ owner, repo, number });

  const latestReviewByUser = {};
  let APPROVED = 0;
  let CHANGES_REQUESTED = 0;

  // get the latest (these are chronologically ordered)
  allReviews.data.forEach(review => latestReviewByUser[review.user.login] = review.state);

  // Count instances of each state. Maybe this could be optimized later. Don't optimize too early though!
  Object.keys(latestReviewByUser).forEach(reviewer => {
    const state = latestReviewByUser[reviewer];
    if (state === 'APPROVED') APPROVED++;
    if (state === 'CHANGES_REQUESTED') CHANGES_REQUESTED++;
  });

  logger.info(`Reviewer check: ${APPROVED} approved and ${CHANGES_REQUESTED} changes requested`);
  return APPROVED >= NUM_REVIEWERS && CHANGES_REQUESTED < 1;
}

// TODO: Implement multiple modes "react" and "respond".
// React will just react to the message about opening the PR
// Respond will send a new message

//TODO: Look at this later. Could cache ghuser/channel/ts/pull_request.node_id combo to look it up and remove it later
// So when we request reviewers cache the info, with PR node ID as the key,
// when a PR is reviewed, look up the PR Node.ghuser and grab the channel/ts info to remove it.
// https://api.slack.com/methods/chat.postMessage
// https://api.slack.com/methods/chat.delete
async function prReviewed(body) {
  let reviewer, coder;
  const logId = shortid.generate();
  try {
    reviewer = await findByGithubName(body.review.user.login, logId);
    coder = await findByGithubName(body.pull_request.user.login, logId);
    if (!reviewer) throw new Error(`[github.prReviewed:${logId}] Reviewer not registered with git slackin`);
    if (!coder) throw new Error(`[github.prReviewed:${logId}] Coder not registered with git slackin`);
  } catch (e) {
    logger.error(`[github.prReviewed:${logId}] Error: ${e}`);
    throw e;
  }

  if (!reviewer) {
    logger.error('[github.prReviewed:${logId}] Missing Reviewer from user list.');
    throw new Error('Could not finder reviewer or coder');
  }

  if (!coder) {
    logger.error('[github.prReviewed:${logId}] Missing Coder from user list.');
    throw new Error('Could not finder reviewer or coder');
  }

  if (reviewer.slack.id === coder.slack.id) {
    const exitEarlyMsg = '[github.prReviewed:${logId}] No need to notify for commenting on your own PR';
    logger.debug(exitEarlyMsg);
    return exitEarlyMsg;
  }

  let emoji = ':speech_balloon:';
  const state = body.review.state.toLowerCase();
  if (state === 'approved') {
    emoji = ':heavy_check_mark:';
  } else if (state === 'changes_requested') {
    emoji = ':x:';
  }

  const message = `${emoji} ${reviewer.name} has reviewed your PR ` +
  `<${body.review.html_url}|${body.pull_request.base.repo.name} PR #${body.pull_request.number}>: ` +
  `\`${body.pull_request.title}\``;

  logger.info(`[PR Reviewed] Reviewer: ${reviewer.name}. Repo: ${body.pull_request.base.repo.name}.` +
  `Sending opener (${coder.name}, id ${coder.slack.id}) a message...`);

  try {
    // let coder know its been done
    await send(coder.slack.id, message);
    let shouldNotify = await checkForReviews({
      owner: body.repository.owner.login,
      repo: body.repository.name,
      number: body.pull_request.number });

    shouldNotify = shouldNotify && body.review.state.toUpperCase() === 'APPROVED';

    if (shouldNotify) {
      const mergerMessage =
      `<${body.review.html_url}|${body.pull_request.base.repo.name} PR #${body.pull_request.number}>: ` +
      `\`${body.pull_request.title}\` has enough reviewers!`;
      return await notifyMergers(mergerMessage);
    }
  } catch (e) {
    logger.error(`[github.prReviewed:${logId}] Error: ${e}`);
    throw new Error(e);
  }
}

function sendPrUpdatedMessage(openerName, users, body) {
  let theUsers = users;
  if (!Array.isArray(theUsers)) theUsers = [theUsers];
  const messagesQueue = theUsers.map(user => {
    if (!user.slack) {
      logger.warn('[Send PR Updated Message] This user is not registered with git slackin');
      return Promise.resolve();
    }
    logger.info(`[Send PR Updated Message] to ${user.name}`);
    const conversationId = user.slack.id;

    const message = `Looks like ${openerName} has updated ` +
    `<${body.pull_request.html_url}|${body.pull_request.base.repo.name} PR #${body.number}> ` +
    `"${body.pull_request.title}" that you reviewed. Please take another look!`;
    const msgObj = {
      text: message,
      attachments: [
        {
          text: 'Hacky workaround will replace message',
          callback_id: 'ISetACallbackId',
          actions: [
            {
              name: 'todo',
              text: 'Done',
              type: 'button',
              value: 'testValue',
            },
          ],
        },
      ],
    };

    return send(conversationId, msgObj);
  });

  return Promise.all(messagesQueue);
}

async function prSynchronize(body) {
  const logId = shortid.generate();
  const opener = await findByGithubName(body.pull_request.user.login, logId);
  const openerName = opener ? opener.name : body.pull_request.user.login;
  const reviewers = await Promise.all(body.pull_request.requested_reviewers.map(user => {
    return findByGithubName(user.login, logId);
  }));

  return await sendPrUpdatedMessage(openerName, reviewers, body);
}

async function notifyOpenerPRClosed(opener, body, merged) {
  if (!opener.slack) return logger.warn('[PR Closed] No slack user to message');
  const conversationId = opener.slack.id;
  const mergedMessage = merged ? ' via merge' : '';
  const message = `:checkered_flag: Your PR <${body.html_url}|PR #${body.number}> ` +
  `\`${body.title.replace('`', '\\`')}\`, on ${body.base.repo.name} ` +
  `was closed${mergedMessage}!\nMake sure to update your tasks in Jira!`;

  const msgObj = {
    text: message,
  };
  return send(conversationId, msgObj);
}

async function prClosed(body) {
  const logId = shortid.generate();
  try {
    const opener = await findByGithubName(body.pull_request.user.login, logId);

    // From https://developer.github.com/v3/activity/events/types/#pullrequestevent action key
    if (opener) {
      await notifyOpenerPRClosed(opener, body.pull_request, body.pull_request.merged);
    } else {
      return logger.warn(`[github.pr.closed:${logId}] No slack user to message`);
    }
    return logger.info(`[github.pr.closed:${logId}] PR Opener notified`);
  } catch (e) {
    logger.error(`[github.pr.closed:${logId}] Error: ${e}`);
    throw e;
  }
}

module.exports = {
  pr: {
    closed: prClosed,
    opened: prOpened,
    reviewed: prReviewed,
    reviewRequested: requestReviewByGithubName,
    sync: prSynchronize,
  },
};
