const express = require('express');
const app = express();
const port = 8778;
const bodyParser = require('body-parser');
const config = require('config');
const logger = require('./logger');
// My modules
const githubWebhooks = require('./lib/github/webhookRouter');
const slackAction = require('./lib/slack/actionHandlers');
const slackEvents = require('./lib/slack/eventHandlers');


// Bootup message stuff
const messenger = require('./lib/slack/message');
const users = require('./lib/users');

async function generateAndSendBootMessage() {
  const availableUsers = await users.listAvailableUsers(true);
  const benchedUsers = await users.listBenchedUsers(true);

  let availableUsersString = availableUsers.join();
  let benchedUsersString = benchedUsers.join();
  if (availableUsersString.length === 0) availableUsersString = 'None';
  if (benchedUsersString.length === 0) benchedUsersString = 'None';

  logger.info('[BOOT] Sending bootup messages');
  const messageObject = {
    text: 'Git Slackin: ONLINE',
    attachments: [
      {
        text: '',
        color: 'good',
        fields: [
          {
            title: 'Available Users',
            value: availableUsersString,
          },
        ],
      },
      {
        text: '',
        color: 'warning',
        fields: [
          {
            title: 'Benched Users',
            value: benchedUsersString,
          },
        ],
      },
    ],
  };

  if (config.get('slack_manager_id')) {
    return messenger.send(config.get('slack_manager_id'), messageObject);
  } else {
    logger.info(`Available Users: ${availableUsersString}\nBenched Users: ${benchedUsersString}`);
  }
}

// could put logic around this.
if (!process.env.GS_SILENT) {
  generateAndSendBootMessage();
} else {
  logger.info('[BOOT] Silent.');
}
// end bootup message stuff

app.use(bodyParser.json());

// Basic web server to handle payloads
app.post('/payload', (req, res) => {
  if (req.headers['x-github-event'] === 'pull_request' ||
  req.headers['x-github-event'] === 'pull_request_review') {
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
  return slackEvents.route(req, res);
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
