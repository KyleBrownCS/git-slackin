const logger = require('../logger');


function verify() {
  logger.warn('NOTE: we should verify this message');
}

function route(req, res) {
  verify();
  logger.info(`[Slack Action] Received event: ${JSON.stringify(req.body, null, 2)}. Params: ${req.params}`);
  return res.sendStatus(200);
}

module.exports = {
  route,
};
