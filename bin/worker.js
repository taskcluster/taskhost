var program = require('commander');
var co = require('co');
var taskcluster = require('taskcluster-client');
var dockerOpts = require('dockerode-options');
var url = require('url');
var loadConfig = require('taskcluster-base/config');
var createLogger = require('../lib/log');
var debug = require('debug')('docker-worker:bin:worker');

var SDC = require('statsd-client')
var Docker = require('dockerode-promise');
var Config = require('../lib/configuration');
var TaskListener = require('../lib/task_listener');
var ShutdownManager = require('../lib/shutdown_manager');
var Stats = require('../lib/stat');

// Available target configurations.
var allowedHosts = ['aws', 'test'];

// All overridable configuration options from the CLI.
var overridableFields =
  ['capacity', 'workerId', 'workerType', 'workerGroup', 'provisionerId'];

// Terrible wrapper around program.option.
function o() {
  program.option.apply(program, arguments);
}

// Usage.
program.usage("[options] <profile>");

// CLI Options.
o('--host <type>',
  'configure worker for host type [' + allowedHosts.join(', ') + ']');
o('-c, --capacity <value>', 'capacity override value');
o('--provisioner-id <provisioner-id>','override provisioner id configuration');
o('--worker-type <worker-type>', 'override workerType configuration');
o('--worker-group <worker-group>', 'override workerGroup');
o('--worker-id <worker-id>', 'override the worker id');

program.parse(process.argv);

// Main.
co(function *() {
  var profile = program.args[0];

  if (!profile) {
    console.error('Config profile must be specified: test, production');
    return process.exit(1);
  }

  var workerConf = loadConfig({
    defaults: require('../config/defaults'),
    profile: require('../config/' + profile),
    filename: 'docker-worker'
  });

  // Placeholder for final configuration options.
  var config = {
    docker: new Docker(dockerOpts()),
    // TODO: Authentication.
    queue: new taskcluster.Queue(),
    scheduler: new taskcluster.Scheduler(),
    schema: require('../lib/schema')()
  };

  // Use a target specific configuration helper if available.
  var host;
  if (program.host) {
    if (allowedHosts.indexOf(program.host) === -1) {
      console.log(
        '%s is not an allowed host use one of: %s',
        program.host,
        allowedHosts.join(', ')
      );
      return process.exit(1);
    }

    host = require('../lib/host/' + program.host);

    // execute the configuration helper and merge the results
    var targetConfig = yield host.configure();
    for (var key in targetConfig) {
      config[key] = targetConfig[key];
    }
  }

  // process CLI specific overrides
  overridableFields.forEach(function(field) {
    if (!(field in program)) return;
    config[field] = program[field];
  });

  debug('configuration loaded', config);

  var statsdConf = url.parse(workerConf.get('statsd:url'));

  // Default to always having at least a capacity of one.
  config.capacity = config.capacity || 1;

  // Raw statsd interface.
  config.statsd = new SDC({
    debug: !!process.env.DEBUG,
    // TOOD: Add real configuration options for this.
    host: statsdConf.hostname,
    port: statsdConf.port,
    // docker-worker.<worker-type>.<provisionerId>.
    prefix: workerConf.get('statsd:prefix') +
      'docker-worker.' +
      config.workerType + '.' +
      config.provisionerId + '.'
  });

  // Wrapped stats helper to support generators, etc...
  config.stats = new Stats(config.statsd);
  config.stats.increment('started');

  config.log = createLogger({
    source: 'top', // top level logger details...
    provisionerId: config.provisionerId,
    workerId: config.workerId,
    workerGroup: config.workerGroup,
    workerType: config.workerType
  });

  configManifest = new Config(config);

  // Build the listener and connect to the queue.
  var taskListener = new TaskListener(configManifest);
  yield taskListener.connect();
  configManifest.log('start');

  // Billing cycle logic is host specific so we cannot handle shutdowns without
  // both the host and the configuration to shutdown.
  if (host && config.shutdown) {
    configManifest.log('handle shutdowns');
    var shutdownManager = new ShutdownManager(host, configManifest);
    shutdownManager.observe(taskListener);
  }

  // Test only logic for clean shutdowns (this ensures our tests actually go
  // through the entire steps of running a task).
  if (workerConf.get('testMode')) {
    // Gracefullyish close the connection.
    process.once('message', co(function* (msg) {
      if (msg.type !== 'halt') return;
      // Halt will wait for the worker to be in an idle state then pause all
      // incoming messages and close the connection...
      function* halt() {
        taskListener.pause();
        yield taskListener.close();
      }
      if (taskListener.isIdle()) return yield halt;
      taskListener.once('idle', co(halt));
    }));
  }
})(function(err) {
  if (!err) return;
  // Top level uncaught fatal errors!
  console.error(err);
  throw err; // nothing to do so show a message and crash
});
