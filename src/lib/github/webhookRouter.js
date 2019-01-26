const config = require('config');
const crypto = require('crypto');

// My Modules
const logger = require('../../logger');
const { pr } = require('./webhookHandlers');

let eventHub = null;

function verifySignature(body, givenAlgSig) {
  try {
    const hmac = crypto.createHmac('sha1', config.get('github_secret'));
    const stringBody = JSON.stringify(body);
    hmac.update(stringBody);
    const calculatedSignature = hmac.digest('hex');
    const [algorithm, givenSignature] = givenAlgSig.split('=');

    const verified = algorithm === 'sha1' && calculatedSignature === givenSignature;
    logger.info(`[Signature Verified] ${verified}`);
    return verified;
  } catch (e) {
    logger.error(`[Signature verification Error] ${e}`);
    return false;
  }
}

function extractPRInfo(body) {
  const openerGithubName = body.pull_request.user.login;
  const prTitle = body.pull_request.title;
  const prURL = body.pull_request.html_url;
  const numAssignees = body.pull_request.assignees.length;
  const assignees = body.pull_request.assignees;
  const owner = body.pull_request.repo.owner.login;
  const repo = body.pull_request.base.repo.name;
  const prNumber = body.pull_request.number;
  const requestedReviewers = body.pull_request.requested_reviewers;
  const requestedReviewerGithubName = body.requested_reviewer.login;

  return {
    openerGithubName, prTitle, prURL, numAssignees, assignees,
    owner, repo, prNumber, requestedReviewers, requestedReviewerGithubName,
  };
}

function extractReviewInfo(body) {
  const reviewerGithubName = body.review.user.login;
  const reviewState = body.review.state;

  const prInfo = extractPRInfo(body);

  const reviewInfo = {
    reviewerGithubName,
    reviewState,
  };

  return Object.assign(prInfo, reviewInfo);
}


// very simple router based on the action that occurred.
async function routeIt(body, { signature }) {
  if (!body.action) throw new Error('no Action');

  // If we have signatures set up, best to check them
  if (config.get('github_secret')) {
    if (!verifySignature(body, signature)) {
      logger.error('Signature Error. Body:');
      logger.error(JSON.stringify(body, null, 2));
      throw new Error('Signatures do not match!');
    }
  }
  logger.info(`[RouteIt] ${body.action} on ${body.pull_request.base.repo.name}`);

  try {
    if (body.action === 'opened') {
      return eventHub.emit('pr.opened', extractPRInfo(body));
    }
    if (body.action === 'submitted') {
      return eventHub.emit('pr.submitted', extractReviewInfo(body));
    }
    if (body.action === 'review_requested') {
      return eventHub.emit('pr.review_requested', extractPRInfo(body));
    }

    if (body.action === 'synchronize') {
      return eventHub.emit('pr.synchronize', extractReviewInfo(body));
    }
  } catch (e) {
    logger.error(e);
    throw e;
  }

  logger.warn(`[RouteIt] No handler for: ${body.action} on ${body.pull_request.base.repo.name}`);
  return Promise.reject('Unhandled action type');
}

function setupSubscriptions() {
  eventHub.on('pr.opened', pr.opened);
  eventHub.on('pr.submitted', pr.reviewed);
  eventHub.on('pr.review_requested', pr.reviewRequested);
  eventHub.on('pr.synchronize', pr.sync);
}

function setup(emitter) {
  eventHub = emitter;
  setupSubscriptions();
}
module.exports = {
  handle: routeIt,
  setupSubscriptions,
  setup,
};
