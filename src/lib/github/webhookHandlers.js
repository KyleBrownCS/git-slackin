const octokit = require('@octokit/rest')();
const config = require('config');

// My Modules
const logger = require('../../logger');
const { selectRandomGithubUsersNot, findByGithubName, filterUsers } = require('../users');
const { send } = require('../slack/message');

// Number of reviewers required for our workflow. Could move to config eventually.
const NUM_REVIEWERS = 2;

// authenticate with Github
octokit.authenticate({
  type: 'token',
  token: config.get('github_token'),
});

function sendReviewRequestMessage(openerName, user, { prURL, repo, prNumber, prTitle }) {
  logger.info(`[Review Request Message] Send to ${user.name}`);
  if (!user || !user.slack) {
    logger.warn('[Review Request Message] No user to send message to');
    return Promise.reject('No Slack ID to sent message to');
  }

  const conversationId = user.slack.id;

  const message = 'Hi! Please look at ' +
  `<${prURL}|${repo} PR #${prNumber}> ` +
  `"${prTitle}" that ${openerName} opened.`;
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

async function sendOpenerInitialStateMessage(opener, reviewers, { prNumber, prURL, prTitle, repo }) {
  if (!opener.slack) return logger.warn('[PR Opened] No slack user to message');
  const conversationId = opener.slack.id;
  const reviewersNames = reviewers.map(user => `<@${user.slack.id}>`);
  const message = `You opened <${prURL}|PR #${prNumber}> ` +
  `\`${prTitle.replace('`', '\\`')}\`, on ${repo}.\n` +
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

async function requestReviewersAndAssignees(users, { owner, repo, prNumber }) {
  try {
    const githubUsers = users.map(user => user.github);

    // Should probably look at the results to check if reviewres are there.
    const reviewRequests = await octokit.pullRequests.createReviewRequest({
      owner,
      repo,
      number: prNumber,
      reviewers: githubUsers,
    });

    // TODO: Remove this, add it as a side effect of requesting review.
    const assignees = await octokit.issues.addAssignees({
      owner,
      repo,
      number: prNumber,
      assignees: githubUsers,
    });

    logger.info(`[Add Users to PR] Repo: ${repo}. ` +
    `Assigned and Request reviews from: ${githubUsers}`);
    return [reviewRequests, assignees];
  } catch (e) {
    logger.error(`Error: ${e}`);
    throw e;
  }
}

async function requestReviewByGithubName({
  openerGithubName, requestedReviewerGithubName, prURL, repo, prNumber, prTitle }) {
  const opener = await findByGithubName(openerGithubName);
  const openerName = opener ? opener.name : openerGithubName;
  const requestedReviewer = await findByGithubName(requestedReviewerGithubName);
  if (requestedReviewer && requestedReviewer.slack) {
    return await sendReviewRequestMessage(openerName, requestedReviewer, { prURL, repo, prNumber, prTitle });
  }
  return logger.warn('[Request Review] Cannot find user');
}

// Handle everything we want to do about opening a PR.
// v1: randomly pick 2 users and send them links on Slack
async function prOpened({ openerGithubName, prTitle, prURL, assignees, owner, repo, prNumber, reviewers }) {
  try {
    // TODO: Have findByGithubName fail better if it can't find the person
    const opener = await findByGithubName(openerGithubName);
    const wipRegex = /^\[*\s*WIP\s*\]*\s+/gi;
    if (wipRegex.test(prTitle) && opener) {
      send(opener,
        `Are you sure you meant to open PR <${prURL}|${prTitle}>? ` +
        'You marked it Work in Progress. So I will ignore it');
    }

    // NOTE: This uses assignees because requested reviewers come back in separate events
    const numReviewersAlready = assignees.length;
    const numReviewersToRandomlySelect = NUM_REVIEWERS - numReviewersAlready;

    const preselectedUsers = await Promise.all(assignees.map(user => {
      return findByGithubName(user.login);
    }));
    const notTheseUsers = opener ? preselectedUsers.concat(opener.github) : preselectedUsers;
    const randomUsers = await selectRandomGithubUsersNot(notTheseUsers, numReviewersToRandomlySelect);
    const users = preselectedUsers.concat(randomUsers);

    // TODO: Handle it better if either fails
    await requestReviewersAndAssignees(randomUsers, { owner, repo, prNumber, reviewers });
    if (opener) {
      await sendOpenerInitialStateMessage(opener, users, { prNumber, prURL, prTitle, repo });
    }

    const openerName = opener ? opener.name : openerGithubName;
    return logger.info(`[PR Opened] Opener: ${openerName} Reviewers Messaged: ${users.map(user => user.name)}`);
  } catch (e) {
    logger.error(`[PR Opened] Error: ${e}`);
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
async function prReviewed({
  reviewerGithubName, openerGithubName, reviewState,
  prURL, repo, prNumber, prTitle, owner,
}) {
  let reviewer, opener;
  try {
    reviewer = await findByGithubName(reviewerGithubName);
    opener = await findByGithubName(openerGithubName);
    if (!reviewer) throw new Error('Reviewer not registered with git slackin');
    if (!opener) throw new Error('opener not registered with git slackin');
  } catch (e) {
    logger.error(`[PR Reviewed] Error: ${e}`);
    throw e;
  }

  if (!reviewer) {
    logger.error('[PR Reviewed] Missing Reviewer from user list.');
    throw new Error('Could not finder reviewer or opener');
  }

  if (!opener) {
    logger.error('[PR Reviewed] Missing opener from user list.');
    throw new Error('Could not finder reviewer or opener');
  }

  if (reviewer.slack.id === opener.slack.id) {
    const exitEarlyMsg = '[PR Reviewed] No need to notify for commenting on your own PR';
    logger.debug(exitEarlyMsg);
    return exitEarlyMsg;
  }

  let emoji = ':speech_balloon:';
  const state = reviewState.toLowerCase();
  if (state === 'approved') {
    emoji = ':heavy_check_mark:';
  } else if (state === 'changes_requested') {
    emoji = ':x:';
  }

  const message = `${emoji} ${reviewer.name} has reviewed your PR ` +
  `<${prURL}|${repo} PR #${prNumber}>: ` +
  `\`${prTitle}\``;

  logger.info(`[PR Reviewed] Reviewer: ${reviewer.name}. Repo: ${repo}.` +
  `Sending opener (${opener.name}, id ${opener.slack.id}) a message...`);

  try {
    // let opener know its been done
    await send(opener.slack.id, message);
    let shouldNotify = await checkForReviews({
      owner,
      repo,
      number: prNumber });

    shouldNotify = shouldNotify && reviewState.toUpperCase() === 'APPROVED';

    if (shouldNotify) {
      const mergerMessage =
      `<${prURL}|${repo} PR #${prNumber}>: ` +
      `\`${prTitle}\` has enough reviewers!`;
      return await notifyMergers(mergerMessage);
    }
  } catch (e) {
    logger.error(`[PR Reviewed] Error: ${e}`);
    throw new Error(e);
  }
}

function sendPrUpdatedMessage(openerName, users, { prURL, repo, prNumber, prTitle }) {
  let theUsers = users;
  if (!Array.isArray(theUsers)) theUsers = [theUsers];
  const messagesQueue = theUsers.map(user => {
    if (!user.slack) {
      logger.warn('[Send PR Updated Message] This user is not registered with git slackin');
      return Promise.resolve();
    }
    logger.info(`[Send PR Updated Message] to ${user.name}`);
    const conversationId = user.slack.id;

    const message = `Looks like ${openerName} has updated` +
    `<${prURL}|${repo} PR #${prNumber}> ` +
    `"${prTitle}" that you reviewed. Please take another look!`;
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

async function prSynchronize({ openerGithubName, requestedReviewers, prURL, repo, prNumber, prTitle }) {
  const opener = await findByGithubName(openerGithubName);
  const openerName = opener ? opener.name : openerGithubName;
  const reviewers = await Promise.all(requestedReviewers.map(user => {
    return findByGithubName(user.login);
  }));

  return await sendPrUpdatedMessage(openerName, reviewers, { prURL, repo, prNumber, prTitle });
}

module.exports = {
  pr: {
    opened: prOpened,
    reviewed: prReviewed,
    reviewRequested: requestReviewByGithubName,
    sync: prSynchronize,
  },
};
