"use strict";
// SNSAdapter
//
// Uses SNS for push notification
const Parse = require('parse/node').Parse;
const GCM = require('parse-server-push-adapter').GCM;
const APNS = require('parse-server-push-adapter').APNS;
const AWS = require('aws-sdk');
const log = require('npmlog');

const LOG_PREFIX = 'parse-server-sns-adapter';

const DEFAULT_REGION = "us-east-1";
const utils = require('parse-server-push-adapter').utils;

function SNSPushAdapter(pushConfig) {
    this.validPushTypes = ['ios', 'gcm', 'adm'];
    this.availablePushTypes = [];
    this.snsConfig = pushConfig.pushTypes;
    this.senderMap = {};

    if (!pushConfig.accessKey || !pushConfig.secretKey) {
        throw new Parse.Error(Parse.Error.PUSH_MISCONFIGURED,
            'Need to provide AWS keys');
    }

    if (pushConfig.pushTypes) {
        let pushTypes = Object.keys(pushConfig.pushTypes);
        for (let pushType of pushTypes) {
            if (this.validPushTypes.indexOf(pushType) < 0) {
                throw new Parse.Error(Parse.Error.PUSH_MISCONFIGURED,
                    'Push to ' + pushTypes + ' is not supported');
            }
            this.availablePushTypes.push(pushType);
            switch (pushType) {
                case 'ios':
                    this.senderMap[pushType] = this.sendToAPNS.bind(this);
                    break;
                case 'gcm':
                    this.senderMap[pushType] = this.sendToGCM.bind(this);
                    break;
                case 'adm':
                    this.senderMap[pushType] = this.sendToADM.bind(this);
                    break;    
            }
        }
    }

    AWS.config.update({
        accessKeyId: pushConfig.accessKey,
        secretAccessKey: pushConfig.secretKey,
        region: pushConfig.region || DEFAULT_REGION
    });

    // Instantiate after config is setup.
    this.sns = new AWS.SNS();
}


SNSPushAdapter.prototype.getValidPushTypes = function () {
    return this.availablePushTypes;
}

/**
   * Classify the device token of installations based on its device type.
   * @param {Object} installations An array of installations
   * @param {Array} validPushTypes An array of valid push types(string)
   * @returns {Object} A map whose key is device type and value is an array of device
   */

SNSPushAdapter.prototype.classifyInstallations = function (installations, validPushTypes) {
    // Init deviceTokenMap, create a empty array for each valid pushType
    var deviceMap = {};
    var _iteratorNormalCompletion = true;
    var _didIteratorError = false;
    var _iteratorError = undefined;

    try {
        for (var _iterator = validPushTypes[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
            var validPushType = _step.value;

            deviceMap[validPushType] = [];
        }
    } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
    } finally {
        try {
            if (!_iteratorNormalCompletion && _iterator.return) {
                _iterator.return();
            }
        } finally {
            if (_didIteratorError) {
                throw _iteratorError;
            }
        }
    }

    var _iteratorNormalCompletion2 = true;
    var _didIteratorError2 = false;
    var _iteratorError2 = undefined;

    try {
        for (var _iterator2 = installations[Symbol.iterator](), _step2; !(_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done); _iteratorNormalCompletion2 = true) {
            var installation = _step2.value;

            // No deviceToken, ignore
            if (!installation.deviceToken) {
                continue;
            }
            let pushType = installation.pushType ? installation.pushType : installation.deviceType;
            log.verbose("clarifying install: ", installation);
            // if (installation.pushType)
            if (deviceMap[pushType]) {
                deviceMap[pushType].push({
                    deviceToken: installation.deviceToken,
                    appIdentifier: installation.appIdentifier
                });
            }
        }
    } catch (err) {
        _didIteratorError2 = true;
        _iteratorError2 = err;
    } finally {
        try {
            if (!_iteratorNormalCompletion2 && _iterator2.return) {
                _iterator2.return();
            }
        } finally {
            if (_didIteratorError2) {
                throw _iteratorError2;
            }
        }
    }

    return deviceMap;
}

SNSPushAdapter.generateiOSPayload = function (data, production) {
    var prefix = "";

    if (production) {
        prefix = "APNS";
    } else {
        prefix = "APNS_SANDBOX"
    }

    var notification = APNS.generateNotification(data.data, data.expirationTime);

    var payload = {};
    payload[prefix] = notification.compile();
    return payload;
}

SNSPushAdapter.generateGCMPayload = function (data, pushId, timeStamp) {
    var pushId = pushId || utils.randomString(10);
    timeStamp = timeStamp || Date.now();
    var payload = GCM.generateGCMPayload(data.data, pushId, timeStamp, data.expirationTime);

    // SNS is verify sensitive to the body being JSON stringified but not GCM key.
    return {
        'GCM': JSON.stringify(payload)
    };
}

SNSPushAdapter.generateADMPayload = function (data, production) {
    let payload = {
        data: data.data
        // expiresAfter: data.expirationTime
    };
    let result = {
        'ADM': JSON.stringify(payload),
    }; 
    
    return result;
}

SNSPushAdapter.prototype.sendToAPNS = function (data, devices) {

    var iosPushConfig = this.snsConfig['ios'];

    let iosConfigs = [];
    if (Array.isArray(iosPushConfig)) {
        iosConfigs = iosConfigs.concat(iosPushConfig);
    } else {
        iosConfigs.push(iosPushConfig)
    }

    let promises = [];

    for (let iosConfig of iosConfigs) {

        let production = iosConfig.production || false;
        var payload = SNSPushAdapter.generateiOSPayload(data, production);

        var deviceSends = [];
        for (let device of devices) {
            device.deviceType = 'ios';
            // Follow the same logic as APNS service.  If no appIdentifier, send it!
            if (!device.appIdentifier || device.appIdentifier === '') {
                deviceSends.push(device);
            } else if (device.appIdentifier === iosConfig.bundleId) {
                deviceSends.push(device);
            }
        }
        if (deviceSends.length > 0) {
            let sendPromises = this.sendToSNS(payload, deviceSends, iosConfig.ARN);
            for (let i = 0; i < sendPromises.length; i++)
                promises.push(sendPromises[i]);
        }
    }

    return promises;
}

SNSPushAdapter.prototype.sendToGCM = function (data, devices) {
    var payload = SNSPushAdapter.generateGCMPayload(data);
    var pushConfig = this.snsConfig['gcm'];
    for (let device of devices) {
        device.deviceType = 'gcm';
    }
    return this.sendToSNS(payload, devices, pushConfig.ARN);
}

SNSPushAdapter.prototype.sendToADM = function (data, devices) {
    var payload = SNSPushAdapter.generateADMPayload(data);
    var pushConfig = this.snsConfig['adm'];
    for (let device of devices) {
        device.deviceType = 'adm';
    }
    return this.sendToSNS(payload, devices, pushConfig.ARN);
}

// Exchange the device token for the Amazon resource ID

SNSPushAdapter.prototype.sendToSNS = function (payload, devices, platformArn) {

    let promises = [];
    devices.map((device) => {
        promises.push(this.exchangeTokenPromise(device, platformArn).then(response => {
            return this.sendSNSPayload(response.arn, payload, response.device);
        }));
    });
    return promises;
}

/**
 * Request a Amazon Resource Identifier if one is not set.
 */

SNSPushAdapter.prototype.getPlatformArn = function (device, arn, callback) {
    var params = {
        PlatformApplicationArn: arn,
        Token: device.deviceToken
    };

    this.sns.createPlatformEndpoint(params, callback);
}

/**
 * Exchange the device token for an ARN
 */
SNSPushAdapter.prototype.exchangeTokenPromise = function (device, platformARN) {
    return new Promise((resolve, reject) => {

        this.getPlatformArn(device, platformARN, (err, data) => {
            if (!err && data.EndpointArn) {
                resolve({device: device, arn: data.EndpointArn});
            }
            else {
                log.error(LOG_PREFIX, "Error sending push " + err);
                log.verbose(LOG_PREFIX, "Error details " + err.stack);
                reject({
                    device: device,
                    transmitted: false
                });
            }
        });
    });
}

/**
 * Send the Message, MessageStructure, and Target Amazon Resource Number (ARN) to SNS
 * @param arn Amazon Resource ID
 * @param payload JSON-encoded message
 * @param device Device info (used for returning push status)
 * @returns {Parse.Promise}
 */
SNSPushAdapter.prototype.sendSNSPayload = function (arn, payload, device) {

    var object = {
        Message: JSON.stringify(payload),
        MessageStructure: 'json',
        TargetArn: arn
    };

    return new Promise((resolve, reject) => {
        var response = {
            device: {
                deviceType: device.deviceType,
                deviceToken: device.deviceToken.toString('hex')
            }
        };

        this.sns.publish(object, (err, data) => {
            if (err != null) {
                log.error(LOG_PREFIX, "Error sending push: ", err);
                response.transmitted = false;
                if (err.stack) {
                    response.response = err.stack;
                }
                return resolve(response);
            }

            if (data && data.MessageId) {
                log.verbose(LOG_PREFIX, "Successfully sent push to " + data.MessageId);
            }

            response.transmitted = true;
            response.response = data;
            resolve(response);
        });
    });
}

/* For a given config object, endpoint and payload, publish via SNS
 * Returns a promise containing the SNS object publish response
 */

SNSPushAdapter.prototype.send = function (data, installations) {
    let deviceMap = this.classifyInstallations(installations, this.availablePushTypes);
    
    let sendPromises = [];
    Object.keys(deviceMap).forEach((pushType) => {
        var devices = deviceMap[pushType];

        if (devices.length) {
            let sender = this.senderMap[pushType];
            let results = sender(data, devices);
            for (let i = 0; i < results.length; i++)
                sendPromises.push(results[i]);
        }
    });

    return Promise.all(sendPromises).then(function (promises) {
        // flatten all
        return [].concat.apply([], promises);
    });
}

module.exports = SNSPushAdapter;
module.exports.default = SNSPushAdapter;
