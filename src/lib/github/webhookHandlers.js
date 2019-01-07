const octokit = require('@octokit/rest')();
const config = require('config');

// My Modules
const logger = require('../../logger');
const { selectRandomGithubUsersNot, findByGithubName } = require('../users');
const { send } = require('../slack/message');

// Number of reviewers required for our workflow. Could move to config eventually.
const NUM_REVIEWERS = 2;

// authenticate with Github
octokit.authenticate({
  type: 'token',
  token: config.get('github_token'),
});

function sendReviewRequestMessage(opener, users, body) {
  let theUsers = users;
  if (!Array.isArray(theUsers)) theUsers = [theUsers];
  const messagesQueue = theUsers.map(user => {
    logger.info(`Send to ${user.name}`);
    const conversationId = user.slack.id;

    const message = 'Hi! Please look at ' +
    `<${body.pull_request.html_url}|${body.pull_request.base.repo.name} PR #${body.number}> ` +
    `"${body.pull_request.title}" that ${opener.name} opened.`;
    const msgObj = {
      text: message,
      attachments: [
        {
          text: 'Hacky workaround will remove message',
          callback_id: 'ISetACallbackId',
          actions: [
            {
              name: 'todo',
              text: 'Remove',
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

async function sendOpenerInitialStateMessage(opener, reviewers, prObj) {
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

    // Should probably look at the results to check if reviewres are there.
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

async function reviewRequested(body) {
  const opener = await findByGithubName(body.pull_request.user.login);
  const requestedReviewer = await findByGithubName(body.requested_reviewer.login);
  return await sendReviewRequestMessage(opener, requestedReviewer, body);
}

// Handle everything we want to do about opening a PR.
// v1: randomly pick 2 users and send them links on Slack
async function prOpened(body) {
  try {
    // TODO: Have findByGithubName fail better if it can't find the person
    const opener = await findByGithubName(body.pull_request.user.login);
    const wipRegex = /^\[*\s*WIP\s*\]*\s+/gi;
    if (wipRegex.test(body.pull_request.title)) {
      send(opener,
        `Are you sure you meant to open PR <${body.pull_request.html_url}|${body.pull_request.title}>? ` +
        'You marked it Work in Progress. So I will ignore it');
    }

    // NOTE: This uses assignees because requested reviewers come back in separate events
    const numReviewersAlready = body.pull_request.assignees.length;
    const numReviewersToRandomlySelect = NUM_REVIEWERS - numReviewersAlready;

    const preselectedUsers = await Promise.all(body.pull_request.assignees.map(user => {
      return findByGithubName(user.login);
    }));
    const randomUsers = await selectRandomGithubUsersNot(
      preselectedUsers.concat(opener.github),
      numReviewersToRandomlySelect);
    const users = preselectedUsers.concat(randomUsers);

    // TODO: Handle it better if either fails
    const results = await Promise.all([
      sendOpenerInitialStateMessage(opener, users, body.pull_request),
      requestReviewersAndAssignees(randomUsers, body),
    ]);
    logger.info(`[PR Opened] Opener: ${opener.name} Reviewers Messaged: ${users.map(user => user.name)}`);
    return results;
  } catch (e) {
    logger.error(`[PR Opened] Error: ${e}`);
    throw e;
  }
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
  try {
    reviewer = await findByGithubName(body.review.user.login);
    coder = await findByGithubName(body.pull_request.user.login);
  } catch (e) {
    logger.error(`[PR Reviewed] Error: ${e}`);
    throw e;
  }

  if (!reviewer) {
    logger.error('[PR Reviewed] Missing Reviewer from user list.');
    throw new Error('Could not finder reviewer or coder');
  }

  if (!coder) {
    logger.error('[PR Reviewed] Missing Coder from user list.');
    throw new Error('Could not finder reviewer or coder');
  }

  if (reviewer.slack.id === coder.slack.id) {
    const exitEarlyMsg = '[PR Reviewed] No need to notify for commenting on your own PR';
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
    return await send(coder.slack.id, message);
  } catch (e) {
    logger.error(`[PR Reviewed] Error: ${e}`);
    throw new Error(e);
  }
}

module.exports = {
  pr: {
    opened: prOpened,
    reviewed: prReviewed,
    reviewRequested: reviewRequested,
  },
};
