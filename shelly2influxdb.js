// insert shellypm_energy,label=server,ref=1 value=8519 1750842056000000000

// insert shellypm_energy,label=server value=9519 1750888256000000000  25/06 23u50
// insert shellypm_energy,label=server value=9519 1750891856000000000  25/06 00u50
// insert shellypm_energy,label=server value=11572 1750974656000000000 26/06 23u50




const Influx = require('influx');
const axios = require('axios').default;
const { JSONPath } = require('jsonpath-plus');

const { logger } = require('./standardlogger.js');
const { mergeConfig } = require('axios');
const config = require('./config.js').parse();


// bucket to keep track of all 'other' measurements
// indexed per db and per retention policy
const bucket = {};
// map of label -> value and timestamp for the Reference energy points
let refEnergyPoints = {};
// map of label -> value and timestamp for the last energy points
let lastEnergyPoints = {};



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
                // energy measurement
                let point = {};
                point.measurement = config.energy ? (config.energy.measurement ? config.energy.measurement : 'shelly_energy') : 'shelly_energy';
                point.tags = { 'label' : shelly.energy.label };
                let data = parseJSONPath(shelly.energy.value, response.data);
                if (data) point.fields = {'value': data};
                if (!isNaN(point.fields.value)) point.fields.value = Number(point.fields.value);
                if (Object.keys(point.fields).length > 0) {
                    point.timestamp = new Date();
                    // fix the energy value if needed
                    fixEnergyValue(point);
                    // push the correct value to the bucket
                    pushToBucket(point, config.energy.database ? config.energy.database : config.influx.database, config.energy.retentionPolicy ? config.energy.retentionPolicy : 'autogen');                    
                } else {
                    logger.warn('Empty value for energy measurement at ${shelly.url}. Nothing sent to influx DB.');
                }

                // other measurements
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
                console.log(e);
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

const getLastEnergyPoints = async (whereClause = 'true') => {
    const db = config.energy.database ? config.energy.database : config.influx.database;
    const response = await influx.query(`select * from ${config.energy.measurement} where ${whereClause} group by * order by desc limit 1`, {'database': db, 'retention': config.energy.retentionPolicy});
    const map={};
    response.forEach(element => {
        map[element.label] = {
            'value': element.value,
            'timestamp':element.time
        }
    });
    return map;
}


const fixEnergyValue = async (point) => {
    
    // calculated the correct value by adding the last REF value to the current value
    let correctedValue = point.fields.value + (refEnergyPoints[point.tags.label] ? refEnergyPoints[point.tags.label].value : 0);
    logger.debug(`Corrected value for ${point.tags.label} is ${correctedValue} (current value: ${point.fields.value}, ref value: ${refEnergyPoints[point.tags.label] ? refEnergyPoints[point.tags.label].value : 0})`);
    logger.debug(`Last energy value: ${lastEnergyPoints[point.tags.label] ? lastEnergyPoints[point.tags.label].value : 'undefined'}`);
    // if the corrected value < last value, the Shelly energy count was reset
    if (correctedValue < lastEnergyPoints[point.tags.label].value) {
        logger.warn(`Shelly ${point.tags.label} was reset. Received value ${point.fields.value}`);
        // create a new reference point and push to the bucket
        // this reference point is a copy of the last point, but with the tag 'ref' set to 1
        const newRef = {
            measurement: config.energy.measurement,
            tags: {'label' : point.tags.label, 'ref' : 1},
            fields: {'value' : lastEnergyPoints[point.tags.label].value},
            timestamp: lastEnergyPoints[point.tags.label].timestamp
        };
        pushToEnergyBucket(newRef);                    
        logger.warn(`Created new REF value ${lastEnergyPoints[point.tags.label].value} to influxdb for label ${point.tags.label}`); 
        // update the refEnergyPoints map to point to the last value and timestamp
        refEnergyPoints[point.tags.label] = {
            'value': lastEnergyPoints[point.tags.label].value,
            'timestamp': lastEnergyPoints[point.tags.label].timestamp
        };
        // recalculate the corrected value
        correctedValue = point.fields.value + refEnergyPoints[point.tags.label].value;
    }
    
    // update the point with the corrected value
    point.fields.value = correctedValue;

    // update the lastEnergyPoints map with the new value and timestamp
    lastEnergyPoints[point.tags.label] = {
        'value': correctedValue,
        'timestamp': point.timestamp
    };    

}



const writePoints = async (points, db, retentionPolicy, energy = false) => {
    // create a buffer containing our points (points might be adapted while sending to influxdb)
    const buffer = [...points];
    try {
        await influx.writePoints(buffer, {
            database: db,
            retentionPolicy: retentionPolicy
        });
        logger.debug(`Wrote ${buffer.length} points to database ${db} with retention policy ${retentionPolicy}`);
        // remove the buffered items from the original points array (probably completely clearing it)
        points.splice(0, buffer.length);
    } catch (err) {
        logger.warn(`Error saving data to database ${db} with retention policy ${retentionPolicy}! ${err.stack}`);
    }
}


// setup the repeater to write the bucket to influxdb
const writeRepeater = setInterval(async function () {
   
    // go over the entries in the 'other' bucket
    for (const db in bucket) {
        for (const retentionPolicy in bucket[db]) {
            const points = bucket[db][retentionPolicy];
            if (points.length > 0) {
                // write to the DB
                await writePoints(points, db, retentionPolicy);
            }
        }
    }
}, 10*1000);




// Create our influx instance
const influx = new Influx.InfluxDB(config.influx);



const go = async () => {
    try {
        // Now, we'll make sure the databases exist
        let names = await influx.getDatabaseNames();
        await createDatabases(names);
        logger.info('Influx DB ready to use.');
        // Obtain the reference and last energy points from the influx DB
        lastEnergyPoints = await getLastEnergyPoints();
        refEnergyPoints = await getLastEnergyPoints("ref='1'");
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