const shortid = require('shortid');
const logger = require('./logger');

class GitSlackinError extends Error {
  constructor(namespace, errorObj, logMessage) {
    super(errorObj.message);
    this.name = 'GitSlackinError';
    this.error = errorObj;
    this.id = shortid.generate();
    this.namespace = namespace;
    this.logMessage = logMessage;
  }

  log() {
    const errorObjMsg = this.errorObj ? `${this.errorObj.name}: ${this.errorObj.message} ::` : '';
    logger.error(`[${this.namespace}:${this.id}] ${errorObjMsg} ${this.logMessage}`);
  }
}

module.exports = GitSlackinError;
