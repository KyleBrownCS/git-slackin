const express = require('express');
const app = express();
const port = 8778;
const bodyParser = require('body-parser');
const config = require('config');
const logger = require('./logger');
// My modules
const githubWebhooks = require('./lib/github/webhookRouter');
const slackAction = require('./lib/slack/actionHandlers');
const slackEventHandler = require('./lib/slack/eventHandlers');
const slackCommon = require('./lib/slack/common');
const { openDM } = require('./lib/slack/message');
// Bootup message stuff

// Handle errors (see `errorCodes` export)


// could put logic around this.
if (!process.env.GS_SILENT) {
  logger.info('[BOOT] Starting up...');
  if (config.get('slack_manager_id')) {
    openDM(config.get('slack_manager_id'))
      .then(dmChannelId => slackCommon.generateAndSendBootMessage(dmChannelId));
  } else {
    logger.warn('[BOOT] No admin user listed for bootup message.');
  }

  if (config.get('slack_announce_channel_id')) {
    slackCommon.generateAndSendBootMessage(config.get('slack_announce_channel_id'));
  } else {
    logger.info('[BOOT] No channel listed for bootup message.');
  }
} else {
  logger.info('[BOOT] Silent.');
}
// end bootup message stuff

app.use(bodyParser.json());
app.use(bodyParser.urlencoded());

// Basic web server to handle payloads
app.post('/payload', (req, res) => {
  if (req.headers['x-github-event'] === 'pull_request' ||
  req.headers['x-github-event'] === 'pull_request_review' ||
  req.headers['x-github-event'] === 'pull_request_review_comment') {
    return githubWebhooks.handle(req.body, { signature: req.headers['x-hub-signature'] })
      .then(() => res.sendStatus(200))
      .catch((msg = 'Not supported') => res.status(500).send(msg));
  } else if (req.headers['x-github-event'] === 'ping') {
    return res.status(200).send('pong');
  } else {
    logger.warn(`[HTTP] Unhandled event type: ${req.headers['x-github-event']}`);
    res.sendStatus(500);
  }
});

app.post('/slack/action', (req, res) => {
  return slackAction.route(req, res);
});

app.post('/slack/events', (req, res) => {
  return slackEventHandler.route(req, res);
});

app.get('/', (req, res) => {
  logger.info('[HTTP] hit /');
  return res.send('Git Slackin\'!');
});

app.listen(port, (err) => {
  if (err) {
    return logger.error('something bad happened', err);
  }

  logger.info(`server is listening on ${port} in mode: ${process.env.NODE_ENV}`);
});
