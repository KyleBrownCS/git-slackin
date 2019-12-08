const appRoot = require('app-root-path');
const winston = require('winston');
const { combine, timestamp, simple, json } = winston.format;

const options = {
  file: {
    level: 'info',
    filename: `${appRoot}/logs/app.log`,
    format: combine(
      timestamp(),
      simple(),
      json()
    ),
  },
  console: {
    level: 'debug',
    format: combine(
      timestamp(),
      winston.format.cli()
    ),
  },
};

const logger = winston.createLogger({
  transports: [
    new winston.transports.File(options.file),
    new winston.transports.Console(options.console),
  ],
  exitOnError: false, // do not exit on handled exceptions
});

module.exports = logger;
