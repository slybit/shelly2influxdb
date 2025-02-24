

const Influx = require('influx');
const axios = require('axios').default;
const { JSONPath } = require('jsonpath-plus');

const { logger } = require('./standardlogger.js');
const { mergeConfig } = require('axios');
const config = require('./config.js').parse();

// create influxDB connector
const influx = new Influx.InfluxDB(config.influx);





const writeToInfux = (point, retentionPolicy = 'autogen') => {

    logger.verbose('Publishing to influx', { 'measurement': point.measurement, 'fields': point.fields, 'tags': point.tags, 'timestamp': point.timestamp, 'Retention': retentionPolicy });
    influx.writePoints([
        point
    ], {
        retentionPolicy: retentionPolicy,
    }).catch(err => {
        logger.warn(`Error saving data to InfluxDB! ${err.stack}`)
    }
    )
}

/*
 * Pull data from the Shelly PM modules
 */
const pullShellyPMData = async () => {
    for (let shelly of config.shellypm) {
        let attempt = 1;
        while (attempt <= 5) {
            try {
                const response = await axios.get(shelly.url);
                for (let m of shelly.measurements) {
                    let point = {};
                    point.measurement = m.measurement;
                    point.tags = {};
                    for (var tag in m.tags) {
                        point.tags[tag] = m.tags[tag];
                    }
                    point.fields = {};
                    for (var field in m.fields) {
                        let data = parseJSONPath(m.fields[field], response.data);
                        if (data) point.fields[field] = data;
                        if (!isNaN(point.fields[field])) point.fields[field] = Number(point.fields[field]);
                    }

                    if (point.measurement && Object.keys(point.fields).length > 0) {
                        writeToInfux(point);
                    } else {
                        if (!point.measurement)
                            logger.warn('No measurement provided. Nothing sent to influx DB.');
                        if (Object.keys(point.fields).length == 0)
                            logger.warn('Empty fields array. Nothing sent to influx DB.');
                    }
                    // set attempt to 5 to immediately escape the while loop
                    attempt = 6; 
                }
            } catch (e) {
                logger.error('Error getting data from shelly', { 'url' : shelly.url, 'attempt' : attempt});
                attempt++;
            }
        }

    }
}

const parseJSONPath = (path, json) => {
    let v = JSONPath({ path, json });
    return v.length > 0 ? v[0] : undefined;
}



/**
 * Now, we'll make sure the database exists and boot the app.
 */
let repeater;
influx.getDatabaseNames()
    .then(names => {
        if (!names.includes(config.influx.database)) {
            return influx.createDatabase(config.influx.database);
        }
    })
    .then(() => {
        logger.info('Influx DB ready to use.');
        // pull the data
        pullShellyPMData();
        // start up the repeater
        repeater = setInterval(function () {
            pullShellyPMData();
        }, config.interval ? config.interval * 1000 : 60 * 1000);
    })
    .catch(err => {
        logger.error('Error connecting to the Influx database!');
        logger.error(err);
        if (repeater) clearInterval(repeater);
    }
    )




