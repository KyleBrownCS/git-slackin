const config = require('config');
const crypto = require('crypto');

// My Modules
const logger = require('../../logger');
const { pr } = require('./webhookHandlers');

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
    if (body.action === 'opened') return await pr.opened(body);
    if (body.action === 'submitted') return await pr.reviewed(body);
    if (body.action === 'review_requested') return await pr.reviewRequested(body);
    if (body.action === 'synchronize') return await pr.sync(body);
  } catch (e) {
    logger.error(e);
    throw e;
  }

  logger.warn(`[RouteIt] No handler for: ${body.action} on ${body.pull_request.base.repo.name}`);
  return Promise.reject('Unhandled action type');
}
module.exports = {
  handle: routeIt,
};
