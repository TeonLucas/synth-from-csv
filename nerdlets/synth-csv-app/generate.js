import React from 'react';
import PropTypes from "prop-types";
import {AccountStorageQuery, Button, NerdGraphMutation, Spinner} from 'nr1';
import locations from './locations';

// Generate Synthetics monitors
export default class Generate extends React.Component {
  static propTypes = {
    accountId: PropTypes.number.isRequired,
    records: PropTypes.array.isRequired,
  }

  constructor(props) {
    super(props)
    var locationMap = {};
    for (const continent of Object.keys(locations.obj)) {
      for (const item of locations.obj[continent]) {
        locationMap[item.label] = item.location
      }
    }
    this.state = {
      locales: {},
      locationMap: locationMap,
      status2frequency: {},
      tagMap: {},
      config: {},
      configErrors: [],
      objs: []
    };
  }

  trimLowerCase(str) {
    return str.replace(/ /g, '').toLowerCase()
  }

  // based on heading names, find required configuration for each monitor
  findConfiguration(headings, tagMap) {
    var config = {tags: {}};
    var tags = Object.entries(tagMap);
    var errors = [];

    for (const [idx, heading] of Object.entries(headings)) {
      const toLower = this.trimLowerCase(heading);

      // find required fields
      if (toLower.includes('status')) {
        config.status = idx;
      } else if (toLower.includes('url')) {
        config.uri = idx;
      } else if (toLower.includes('locale')) {
        config.locale = idx;
      } else if (toLower.includes('monitorname')) {
        config.name = idx;
      }

      // find tags
      for (const item of Object.entries(tagMap)) {
        const [key, value] = item
        if (value.enabled && toLower === this.trimLowerCase(value.heading)) {
          config.tags[key] = idx;
        }
      }
    }

    if (!config.status) {
      errors.push('Account Status column not found in spreadsheet');
    }
    if (!config.uri) {
      errors.push('URL column not found in spreadsheet');
    }
    if (!config.locale) {
      errors.push('Locale column not found in spreadsheet');
    }
    if (!config.name) {
      errors.push('Name column not found in spreadsheet');
    }
    if (Object.keys(config.tags).length === 0) {
      errors.push('Tags not found in spreadsheet - please update Settings or verify spreadsheet column names')
    }

    //console.log('CONFIG: ', JSON.stringify(config));
    return [config, errors];
  }

  makeObject(idx, record, config, locales, locationMap, status2frequency) {
    const {accountId} = this.props;
    var obj = {
      row: idx,
      accountId: accountId,
      period: 'UNKNOWN',
      uri: 'UNKNOWN',
      locations: [],
      name: 'UNKNOWN',
      tags: [],
      errors: [],
      status: 'Awaiting generation'
    };
    if (config.status) {
      const status = record[config.status];
      if (status) {
        const period = status2frequency[status];
        if (period) {
          obj.period = period;
        } else {
          obj.errors.push('Unrecognized Account Status "' + status + '" - please update Settings or verify spreadsheet column names');
        }
      } else {
        obj.errors.push('Account Status missing');
      }
    } else {
      obj.errors.push('Account Status / period error');
    }
    if (config.uri) {
      const uri = record[config.uri];
      if (uri) {
        obj.uri = uri;
      } else {
        obj.errors.push('URL missing');
      }
    } else {
      obj.errors.push('URL error');
    }
    if (config.locale) {
      const locale = record[config.locale];
      if (locale) {
        const locs = locales[locale];
        if (locs) {
          for (const label of locs) {
            obj.locations.push(locationMap[label])
          }
        } else {
          obj.errors.push('Locations not configured for Locale "' + locale + '" - please update Settings');
        }
      } else {
        obj.errors.push('Locale missing');
      }
    } else {
      obj.errors.push('Locale error');
    }
    if (config.name) {
      const name = record[config.name];
      if (name) {
        obj.name = name;
      } else {
        obj.errors.push('Name missing');
      }
    } else {
      obj.errors.push('Name error');
    }
    const entries = Object.entries(config.tags);
    if (entries.length > 0) {
      for (const [label, idx] of entries) {
        const value = record[parseInt(idx)];
        if (value) {
          obj.tags.push({key: label, values: [value]});
        } else {
          obj.errors.push('Tag value for "' + label + '" Column missing');
        }
      }
    } else {
      obj.errors.push('Tags error');
    }

    //console.log('OBJECT: ', JSON.stringify(obj));
    return obj;
  }

  componentDidMount() {
    const {records, accountId} = this.props;
    const {locationMap} = this.state;
    var headings = [];
    if (records.length > 0) {
      headings = records[0];
    }

    // load locale map, frequency map, and tag list from NerdStorage
    var result = {};
    AccountStorageQuery.query({accountId: accountId, collection: 'locale2locations', documentId: 'current'})
      .then(({data}) => {
        result.locales = data;
        return AccountStorageQuery.query({accountId: accountId, collection: 'status2frequency', documentId: 'current'});
      })
      .then(({data}) => {
        result.status2frequency = data;
        return AccountStorageQuery.query({accountId: accountId, collection: 'tagmap', documentId: 'current'});
      })
      .then(({data}) => {
        result.tagMap = data;
        const [config, configErrors] = this.findConfiguration(headings, result.tagMap);
        // convert records to objects
        var objs = [];
        var idx = 2;
        //console.log("Loaded:", JSON.stringify(result))
        for (const record of records.slice(1, records.length)) {
          const obj = this.makeObject(idx, record, config, result.locales, locationMap, result.status2frequency)
            objs.push(obj);
          idx++;
        }
        this.setState({config, configErrors, tagMap: result.tagMap, objs, locales: result.locales, status2frequency: result.status2frequency});
      });
  }

  makeMonitors(objs) {
    const createMonitor = `mutation ($name: String!, $accountId: Int!, $period: SyntheticsMonitorPeriod!, $locations: [String], $uri: String!) {
      syntheticsCreateSimpleBrowserMonitor(accountId: $accountId, monitor: {
        name: $name,
        status: DISABLED,
        period: $period,
        locations: {public: $locations},
        uri: $uri,
        runtime: {runtimeType: "CHROME_BROWSER", runtimeTypeVersion: "100", scriptLanguage: "JAVASCRIPT"}
      }) {
        errors { description }
        monitor { guid }
      }
    }`
    const tagMonitor = `mutation ($guid: EntityGuid!, $tags: [TaggingTagInput!]!) {
      taggingAddTagsToEntity(guid: $guid, tags: $tags) {
        errors {
          message
          type
        }
      }
    }`
    for (const obj of objs) {
      console.log('Executing GraphQl mutations to create monitor', obj.name);
      //console.log(createMonitor);
      //console.log('Variables:', JSON.stringify(obj));
      NerdGraphMutation.mutate({mutation: createMonitor, variables: obj})
        .then(result => {
          const data = result.data.syntheticsCreateSimpleBrowserMonitor;
          var messages = [];
          if (data.errors.length > 0) {
            for (const error of data.errors) {
              messages.push(error.__typename + ': ' + error.description)
            }
            obj.status = messages.join(", ");
            this.setState({objs: objs});
          } else {
            const guid = data.monitor.guid;
            const vars = {guid: guid, tags: obj.tags}
            messages.push('Success, guid: ' + guid)
            //console.log(tagMonitor);
            //console.log('Variables:', JSON.stringify(vars));
            NerdGraphMutation.mutate({mutation: tagMonitor, variables: vars})
              .then(result => {
                const errors = result.data.taggingAddTagsToEntity.errors;
                if (errors.length > 0) {
                  for (const error of errors) {
                    messages.push(error.__typename + ': ' + error.description)
                  }
                }
                obj.status = messages.join(", ");
                this.setState({objs: objs});
              });
          }
        });
    }
  }

  makeTable(objs, configErrors) {
    var table = <h1>No data</h1>;

    if (objs && objs.length > 0) {
      var issues = [];
      for (const text of configErrors) {
        issues.push({location: 'Spreadsheet headings', description: text})
      }
      // make either a list of issues or rows to generate
      for (const obj of objs) {
        if (obj.errors.length > 0) {
          for (const text of obj.errors) {
            issues.push({location: 'Spreadsheet row ' + obj.row, description: text})
          }
        }
      }
      if (issues.length === 0) {
        table = <div>
          <h1>Validated {objs.length} monitors, no issues</h1>
          <br/>
          <Button onClick={() => this.makeMonitors(objs)}>
            Generate Monitors
          </Button>
          <table>
            <tbody>
            <tr>
              <th>Row</th>
              <th>Name</th>
              <th>Status</th>
            </tr>
            {objs.map(row => <tr>
                <td>{row.row}</td>
                <td>{row.name}</td>
                <td>{row.status}</td>
              </tr>
            )}
            </tbody>
          </table>
        </div>;
      } else {
        table = <div>
          <h1>{issues.length} Issues Found!</h1>
          <table>
            <tbody>
              <tr>
                <th>Location</th>
                <th>Description</th>
              </tr>
              {issues.map(issue => <tr>
                  <td>{issue.location}</td>
                  <td>{issue.description}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>;
      }
    }
    return table;
  }

  render() {
    const {config, configErrors, locales, objs} = this.state;

    if (Object.keys(config).length === 0 || Object.keys(locales).length === 0) {
      return <Spinner/>;
    }
    return this.makeTable(objs, configErrors);
  }
}
