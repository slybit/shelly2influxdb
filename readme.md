# shelly2influxdb

A node.js application that pulls data from Shelly modules and sends it to an Influx database.

All configuration is done in a single `config.yaml` file.


## Configuration of the InfluxDB connection

The **influx:** section is passed straight to InfluxDB constructor of the node-influx library (https://node-influx.github.io/class/src/index.js~InfluxDB.html).

```javascript
const influx = new Influx.InfluxDB(config.influx);
```

## Polling interval

The **interval** parameter sets the polling interval in seconds.

## InfluxDB measurement configuration

The **shellypm** section contains the configuration of the measurement that will be sent to InfluxDB.

This is an example measurement:

```yaml
shellypm:
  - url: http://192.168.1.60/rpc/Shelly.GetStatus
    measurements:
      - measurement: shellypm_energy
        tags:
          label: shellypmminig3-airco-bureau
        fields:
          energy: $.pm1:0.aenergy.total
```

- `url`: A GET will be issues to that URL and the JSON response will be used as data
- `measurements`: can contain one or more measurement definitions:

  - `measurement`: name of the measurement to use in InfluxDB
  - `tags`: one or more tags to attach to this measurement
  - `fields`: one or more fields to add to the measurement - the value of each field is provided as a JSONPATH that will be evaluated against the data returned by the GET