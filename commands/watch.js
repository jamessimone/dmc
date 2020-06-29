var Promise = require("bluebird");
var glob = Promise.promisify(require("glob"));
var cliUtil = require("../lib/cli-util");
var _ = require("lodash");
var logger = require("../lib/logger");
var watch = require("node-watch");
var hl = logger.highlight;

var deploy = require("./deploy");

var globOpts = {
  matchBase: true,
  nodir: false,
  noglobstar: false,
  nomount: true,
};

var run = (module.exports.run = function (opts) {
  if (!opts.globs || !opts.globs.length) {
    opts.globs = ["src/**/*", "force-app/main/default/**/*"];
  }

  Promise.reduce(
    opts.globs,
    function (allFiles, file) {
      return glob(file, globOpts).then((files) => {
        return allFiles.concat(files);
      });
    },
    []
  ).then(function (allFiles) {
    logger.log("now watching " + hl(allFiles.length) + " files");

    var watcher = watch(_.uniq(allFiles), { encoding: "utf8" });
    var promiseWatcher = Promise.promisify((evt, name) => {
      if (evt === "update") {
        deploy.run(
          {
            org: opts.org,
            oauth: opts.oauth,
            globs: [name],
            meta: opts.meta,
          },
          function (err, res) {
            if (err) {
              logger.error(
                `deploy failed: ${JSON.stringify(err)}, re-watching files`
              );
            } else {
              if (res && res !== null)
                logger.success("deploy complete: re-watching files");
            }
          }
        );
      }
    });

    watcher.on("change", promiseWatcher);
  });
});

module.exports.cli = function (program) {
  program
    .command("watch [globs...]")
    .description("watch files and deploy metadata to target org")
    .option("-o, --org <org>", "the Salesforce organization to use")
    .option("--meta", "force deploy with metadata api")
    .action(function (globs, opts) {
      opts.globs = globs;
      opts._loadOrg = true;
      return cliUtil.executeRun(run)(opts);
    });
};
