

const Influx = require('influx');
const axios = require('axios').default;
const { JSONPath } = require('jsonpath-plus');

const { logger } = require('./standardlogger.js');
const { mergeConfig } = require('axios');
const config = require('./config.js').parse();



const bucket = {};



const pushToBucket = function (point, database = undefined, retentionPolicy = 'autogen') {

    const db = database ? database : config.influx.database;
    logger.debug('Add to bucket', {'database': db, 'measurement': point.measurement, 'fields': point.fields, 'tags': point.tags, 'timestamp': point.timestamp, 'retention': retentionPolicy});

    if (!bucket.hasOwnProperty(db)) bucket[db] = {};
    if (!bucket[db].hasOwnProperty(retentionPolicy)) bucket[db][retentionPolicy] = [];
    
    bucket[db][retentionPolicy].push(point);
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
                        point.timestamp = new Date();
                        pushToBucket(point, m.database, m.retentionPolicy);
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

const createDatabases = async (names) => {
    // name contains the already existing databases
    for (let dbItem of config.databases) {
        if (!names.includes(dbItem.name)) {
            await influx.createDatabase(dbItem.name);            
            logger.info(`Create influx database ${dbItem.name}`);
        }
        await createRetentionPolicies(dbItem);
    }
    

}


const createRetentionPolicies = async (dbItem) => {
    let policies = await influx.showRetentionPolicies(dbItem.name);   
      
    for (let p of policies) {
        for (let rp of dbItem.retentionPolicies) {
            if (p.name === rp.name) rp.exists = true;
        }
    }
    for (let rp of dbItem.retentionPolicies) {
        if (!rp.exists) {
            await influx.createRetentionPolicy(rp.name, {
                database: dbItem.name,
                duration: rp.duration,
                replication: rp.replication ? rp.replication : 1
            });
            logger.info(`Create influx retention policy ${rp.name} for database ${dbItem.name}`);
        }
    }
}


// setup the repeater to write the bucket to influxdb
const writeRepeater = setInterval(async function () {
    
    // go over the entries in the bucket
    let i = 0;
    for (const db in bucket) {
        for (const retentionPolicy in bucket[db]) {
            const points = bucket[db][retentionPolicy];
            if (points.length > 0) {
                setTimeout(async () => {
                    try {
                        await influx.writePoints(points, {
                            database: db,
                            retentionPolicy: retentionPolicy
                        });
                        logger.debug(`Wrote ${points.length} points to database ${db} with retention policy ${retentionPolicy}`);
                    } catch (err) {
                        logger.warn(`Error saving data to database ${db} with retention policy ${retentionPolicy}! ${err.stack}`);
                    }
                    // clear the bucket for this retention policy
                    bucket[db][retentionPolicy] = [];
                }, i++ * 200);
            }
        }
    }
}, 60*1000);




// Create our influx instance
const influx = new Influx.InfluxDB(config.influx);

const go = async () => {
    try {
        // Now, we'll make sure the databases exist
        let names = await influx.getDatabaseNames();
        await createDatabases(names);
        logger.info('Influx DB ready to use.');
        // pull the data
        pullShellyPMData();
        // start up the repeater
        repeater = setInterval(function () {
            pullShellyPMData();
        }, config.interval ? config.interval * 1000 : 60 * 1000);
    } catch (err) {
            logger.error(`Error connecting to the Influx database! ${err.stack}`);
            if (repeater) clearInterval(repeater);
    }
}


go();