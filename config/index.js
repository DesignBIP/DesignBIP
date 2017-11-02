/*jshint node: true*/

'use strict';

var env = process.env.NODE_ENV || 'default',
    configFilename = __dirname + '/config.' + env + '.js',
    config = require(configFilename),
    validateConfig = require('webgme/config/validator');

validateConfig(configFilename);
module.exports = config;