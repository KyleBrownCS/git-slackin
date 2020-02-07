const express = require('express');
const app = express();
const http = require('http');
const https = require('https'); // TODO: Use this to serve up HTTPS properly
const fs = require('fs');
const path = require('path');
const port = 8778;
const httpsPort = 8779;
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

if (process.env.GS_DEAD_SILENT) {
  logger.warn('[BOOT] Silent Running, not even telling the managers... Shhhh....');
} else if (config.has('slack_manager_ids') && Array.isArray(config.get('slack_manager_ids'))) {
  config.get('slack_manager_ids').forEach(slackId => {
    return openDM(slackId)
      .then(dmChannelId => slackCommon.generateAndSendBootMessage(dmChannelId));
  });
} else {
  logger.warn('[BOOT] No admin user listed for bootup message or set to silent');
}
// silent just means it won't announce it to the entire team every time.
if (process.env.GS_SILENT || (config.has('silent_boot') && config.get('silent_boot') === true)) {
  logger.info('[BOOT] Silent.');
} else {
  logger.info('[BOOT] Starting up...');

  if (config.get('slack_announce_channel_id')) {
    slackCommon.generateAndSendBootMessage(config.get('slack_announce_channel_id'));
  } else {
    logger.info('[BOOT] No channel listed for bootup message.');
  }
}
// end bootup message stuff

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Basic web server to handle payloads
app.post('/payload', (req, res) => {
  if (req.headers['x-github-event'] === 'pull_request' ||
  req.headers['x-github-event'] === 'pull_request_review' ||
  req.headers['x-github-event'] === 'pull_request_review_comment') {
    return githubWebhooks.handle(req.body, {
      signature: req.headers['x-hub-signature'],
      webhookId: req.headers['x-github-delivery'],
    })
      .then(() => res.sendStatus(200))
      .catch((msg = 'Not supported') => res.status(500).send(msg));
  } else if (req.headers['x-github-event'] === 'ping') {
    return res.status(200).send('pong');
  } else {
    logger.warn(`[HTTP] Unhandled event type: ${req.headers['x-github-event']}`);
    res.sendStatus(406);
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

// For use with Let's Encrypt
app.get('/.well-known/acme-challenge/:token', (req, res) => {
  const challengeFilePath = path.join(__dirname, '..', 'letsencrypt', 'secret.txt');
  fs.readFile(challengeFilePath, (err, contents) => {
    if (!err) {
      return res.send(contents);
    } else {
      logger.err(`Could not complete ACME challenge. Error: ${err}`);
      return res.sendStatus(500); // send a generic error back
    }
  });
});

http.createServer(app)
  .listen(port, (err) => {
    if (err) {
      return logger.error('something bad happened', err);
    }

    logger.info(`server is listening on ${port} in mode: ${process.env.NODE_ENV}`);
  });

if (!process.env.GS_INSECURE) {
  https.createServer({
    key: fs.readFileSync(path.join(__dirname, '..', 'letsencrypt', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, '..', 'letsencrypt', 'cert.pem')),
    ca: fs.readFileSync(path.join(__dirname, '..', 'letsencrypt', 'chain.pem')),
  }, app)
    .listen(httpsPort, (err) => {
      if (err) {
        return logger.error('something bad happened', err);
      }

      logger.info(`server is listening on ${port} in mode: ${process.env.NODE_ENV}`);
    });
}
