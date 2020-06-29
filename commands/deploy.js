var fs = require("fs-extra");
var cliUtil = require("../lib/cli-util");
var sfClient = require("../lib/sf-client");
var config = require("../lib/config");
var metaMap = require("../lib/metadata-map");
var getFiles = require("../lib/get-files");
var Promise = require("bluebird");
var async = require("async");
var _ = require("lodash");
var archiver = require("archiver");
var logger = require("../lib/logger");
var dmcignore = require("../lib/dmcignore");
var resolve = require("../lib/resolve");
var hl = logger.highlight;

var timesBeingDeployed = 0;

function createStubFiles(map, client) {
  var keys = map.index.getMemberTypeNames();

  function iterator(obj, cb) {
    logger.create(obj.type + "::" + hl(obj.object.name));
    client.tooling.insert(obj, function (err, res) {
      if (err) return cb(err);
      map.setMetaId(obj.type, obj.object.name, res.id);
      cb(null, res.id);
    });
  }

  return new Promise(function (resolve, reject) {
    var stubs = [];

    _.each(keys, function (k) {
      _(map.meta[k])
        .filter(function (o) {
          return !o.id || o.id === null || o.id === "";
        })
        .each(function (o) {
          stubs.push(metaMap.getStub(k, o.name, o.object));
        });
    });

    if (!stubs || !stubs.length) return resolve([]);

    async.mapLimit(stubs, 5, iterator, function (err, results) {
      if (err) {
        logger.error(err.message);
        return reject(new Error("unable to create stub files"));
      } else {
        return resolve(results);
      }
    });
  });
}

function createStaticResources(map, client) {
  function iterator(obj, cb) {
    fs.readFile(obj.path, { encoding: "base64" }, function (err, body) {
      if (err) return cb(err);

      var opts = {
        id: obj.id,
        type: "StaticResource",
        object: {
          name: obj.name,
          contenttype: "application/zip", // hard-coding this for now
          body: body,
        },
      };

      var method = obj.id ? "update" : "insert";

      logger.log("executing StaticResource " + method);

      client.tooling[method](opts, function (err, res) {
        if (err) return cb(err);
        logger[method === "insert" ? "create" : "update"](
          "StaticResource::" + obj.name
        );
        cb(null, res);
      });
    });
  }

  return new Promise(function (resolve, reject) {
    async.mapLimit(map.meta.StaticResource, 5, iterator, function (err, srs) {
      if (err) {
        logger.error("StaticResource deploy error");
        return reject(err);
      }
      resolve(srs);
    });
  });
}

function createContainer(client) {
  logger.log("creating container");
  var name = "dmc:" + new Date().getTime();

  return new Promise(function (resolve, reject) {
    client.tooling.createContainer({ name: name }, function (err, container) {
      if (err) return reject(err);
      logger.create("metadata container: " + hl(container.id));
      resolve(container.id);
    });
  });
}

function createDeployArtifacts(map, containerId, client) {
  var iterator = function (m, cb2) {
    if (map.index.getMemberTypeNames().indexOf(m.type) === -1) {
      return cb2(null);
    }

    fs.readFile(m.path, { encoding: "utf8" }, function (err, data) {
      if (err) return cb2(err);

      var artifact = client.tooling.createDeployArtifact(m.type + "Member", {
        body: data,
        contentEntityId: m.id,
      });

      if (!artifact) {
        return cb2(new Error("couldn't create artifact: " + m.name));
      }

      var opts = {
        id: containerId,
        artifact: artifact,
      };

      client.tooling.addContainerArtifact(opts, function (err, resp) {
        if (err) {
          logger.error(
            "problem creating container artifact: " + m.type + "::" + m.name
          );
          return cb2(err);
        }
        logger.create("container member: " + m.type + "::" + m.name);
        return cb2(null, resp);
      });
    });
  };

  return new Promise(function (resolve, reject) {
    var files = _(map.meta)
      .values()
      .flatten()
      .remove(function (m) {
        return m.id && m.id !== "";
      });

    async.mapLimit(files, 5, iterator, function (err, res) {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

//TOOLING API DEPLOY
function deployContainer(containerId, client) {
  if (!containerId) return;

  return new Promise(function (resolve, reject) {
    var asyncContainerId;

    var opts = {
      id: containerId,
      isCheckOnly: false,
    };

    function logStatus(status) {
      logger.list("deploy status: " + hl(status));
    }

    function poll() {
      var pollOpts = {
        id: asyncContainerId,
      };

      client.tooling.getContainerDeployStatus(pollOpts, function (err, resp) {
        if (err) return reject(err);

        logStatus(resp.State);

        if (resp.State === "Completed") {
          logger.success("deployment successful");
          return resolve(resp);
        } else if (resp.State === "Failed") {
          if (resp.ErrorMsg) logger.error(resp.ErrorMsg);

          if (resp.CompilerErrors) {
            _.each(resp.CompilerErrors, function (e) {
              logger.error("=> " + e.extent[0] + ": " + e.name[0]);
              logger.error("   Line " + e.line[0] + " - " + e.problem[0]);
            });
          }

          if (resp.DeployDetails) {
            logDetails(resp.DeployDetails);
          }

          return reject(new Error("Compiler Errors"));
        } else if (resp.State === "Errored") {
          if (resp.ErrorMsg) logger.error(res.ErrorMsg);
          return reject(
            new Error(
              res.ErrorMsg ||
                "Tooling API deploy failed. Check Salesforce for more details"
            )
          );
        } else {
          setTimeout(function () {
            poll();
          }, 1500);
        }
      });
    }

    client.tooling.deployContainer(opts, function (err, asyncContainer) {
      if (err) return cb(err);
      logger.log("Deploying...");
      asyncContainerId = asyncContainer.id;
      poll();
    });
  });
}

function deleteContainer(containerId, client) {
  var opts = {
    type: "MetadataContainer",
    id: containerId,
  };

  return new Promise(function (resolve, reject) {
    client.tooling.delete(opts, function (err, res) {
      if (err) return reject(err);
      logger.destroy("metadata container: " + hl(containerId));
      resolve(containerId);
    });
  });
}

function runToolingDeploy(map, client) {
  var containerId;

  if (timesBeingDeployed > 0) return Promise.resolve();

  return (
    Promise.resolve()
      .then(timesBeingDeployed++)
      .then(function () {
        logger.log("loading related metadata ids");

        return map.fetchIds().then((results) => {
          if (results.length > 0) {
            logger.log("loaded " + hl(results.length) + " ids");
          }
        });
      })

      // create stub files if necessary
      .then(() => {
        logger.log("creating stub files");
        return createStubFiles(map, client).then(function (stubs) {
          if (stubs.length === 0) {
            return;
          }
          logger.log("created " + hl(stubs.length) + " stub files");
        });
      })

      // create static resources
      .then(() => {
        logger.log("creating static resources");
        return createStaticResources(map, client).then(function (srs) {
          if (srs.length === 0) {
            return;
          }
          logger.log("deployed " + hl(srs.length) + " static resources");
        });
      })

      .then(() => {
        return createContainer(client);
      })

      .then((id) => {
        containerId = id;
        return createDeployArtifacts(map, containerId, client);
      })

      .then(() => {
        return deployContainer(containerId, client);
      })

      .finally(() => {
        if (containerId) {
          timesBeingDeployed = 0;
          return deleteContainer(containerId, client);
        }
      })
  );
}

function logDetails(details, opts) {
  if (!details) return;

  var changed = false;

  if (details.componentSuccesses) {
    _(details.componentSuccesses)
      .map(function (e) {
        e.cType =
          _.isString(e.componentType) && e.componentType.length
            ? e.componentType + ": "
            : "";

        e.method = e.created
          ? "create"
          : e.changed
          ? "update"
          : e.deleted
          ? "destroy"
          : "noChange";

        return e;
      })
      .sortBy(function (e) {
        return e.cType + e.fullName;
      })
      .each(function (e) {
        if (e.fullName !== "package.xml" && e.changed) changed = true;
        logger[e.method](e.cType + e.fullName);
      });

    if (changed)
      logger.success(
        "component successes [" + details.componentSuccesses.length + "] ====>"
      );
  }

  if (details.componentFailures) {
    logger.error(
      "component failures [" + details.componentFailures.length + "] ====>"
    );

    _(details.componentFailures)
      .map(function (e) {
        e.cType =
          e.componentType && _.isString(e.componentType)
            ? e.componentType + ": "
            : "";

        return e;
      })
      .sortBy(function (e) {
        return e.cType + e.fullName;
      })
      .each(function (e) {
        logger.listError(
          "[" +
            e.cType +
            e.fullName +
            "] " +
            e.problemType +
            " at " +
            "l:" +
            (e.lineNumber || "0") +
            "/" +
            "c:" +
            (e.columnNumber || "0") +
            " " +
            "=> " +
            e.problem
        );
      });
  }

  if (details.runTestResult && details.runTestResult.numTestsRun > 0) {
    if (details.runTestResult.numFailures) {
      logger.error("test results ====>");
    } else {
      logger.success("test results ====>");
    }

    logger.list("tests run: " + details.runTestResult.numTestsRun);
    logger.list("failures: " + details.runTestResult.numFailures);
    logger.list("total time: " + details.runTestResult.totalTime / 1000 + "s");
    var cc = details.runTestResult.codeCoverage;

    if (opts.coverage && cc && cc.length) {
      logger.success("code coverage results ====>");

      _(cc)
        .map(function (c) {
          var locations = c.numLocations;
          var notCovered = c.numLocationsNotCovered;
          var covered = locations - notCovered;
          var coverage = (covered / locations) * 100;

          if (locations === 0) {
            coverage = 100;
          }

          return {
            type: c.type,
            name: c.name,
            locations: locations,
            notCovered: notCovered,
            covered: covered,
            coverage: coverage,
          };
        })
        .sortBy(function (c) {
          return c.coverage * -1;
        })
        .each(function (c) {
          logger.list(
            c.coverage.toFixed(2) +
              "% => " +
              c.type +
              ":" +
              c.name +
              " (" +
              c.covered +
              "/" +
              c.locations +
              ")"
          );
        });
    }

    var ccw = details.runTestResult.codeCoverageWarnings;

    if (ccw && ccw.length) {
      logger.error("code coverage warnings ====>");
      _.each(ccw, function (w) {
        logger.list(w.message);
      });
    }

    _.each(details.runTestResult.failures, function (f) {
      logger.error(f);
    });
  }
}

function runMetadataDeploy(map, client, opts) {
  if (timesBeingDeployed > 0) return Promise.resolve();

  return new Promise(function (resolve, reject) {
    var archive = archiver("zip");

    var promise = client.meta.deployAndPoll({
      zipFile: archive,
      includeDetails: true,
      deployOptions: {
        rollbackOnError: true,
        runAllTests: opts.tests ? opts.tests : false,
      },
    });

    const baseString =
      opts.globs.length && opts.globs[0].indexOf("force-app") > -1
        ? "force-app/main/default"
        : "src";

    // write the package.xml to the zip
    var packageXML = map.createPackageXML(client.apiVersion);
    archive.append(Buffer.from(packageXML), {
      name: "src/package.xml",
    });

    promise.poller.on("poll", function (res) {
      logger.log("deploy status: " + hl(res.status));
    });

    promise
      .then(function (results) {
        logDetails(results.details, opts);
        timesBeingDeployed = 0;
        resolve(1);
      })
      .catch(function (err) {
        if (err.details) {
          logDetails(err.details, opts);
        }
        if (err.message) {
          logger.error(err.message);
        }
        if (err.errorMessage) {
          logger.error(err.errorMessage);
        }
        reject(err);
      });

    // iterator for adding files
    // checks for existence and adds
    function iterator(p, cb) {
      var exists;

      fs.existsAsync(p)
        .then(function (e) {
          exists = e;

          if (!exists) {
            throw new Error("missing file: " + p);
          }

          return fs.lstatAsync(p);
        })
        .then(function (stat) {
          //fix for SFDX project structure
          const destPath = p.replace("force-app/main/default", "src");
          if (stat.isDirectory()) {
            archive.directory(p, destPath);
          } else {
            archive.file(p, destPath);
          }
          logger.list(destPath);

          cb(null, {
            file: p,
            exists: exists,
          });
        });
    }

    logger.log("adding metadata");

    // map over files to add and add if they exist
    async.mapLimit(map.getFilePathsForDeploy(), 5, iterator, function (
      err,
      res
    ) {
      if (err) {
        return reject(err);
      } else {
        var hasErrors = false;

        _.each(res, function (r) {
          if (!r.exists) {
            logger.error("missing file: " + r.file);
            hasErrors = true;
            return;
          }
        });

        if (hasErrors) {
          return reject(new Error("cannot deploy - missing files"));
        }

        logger.log("starting deploy");
        archive.finalize();
      }
    });
  });
}

var run = (module.exports.run = function (opts, cb) {
  return resolve(cb, function () {
    var client;
    var globs =
      opts.globs && opts.globs.length > 0
        ? opts.globs
        : ["src/**/*", "force-app/main/default/**/*"];

    var map = metaMap.createMap({
      oauth: opts.oauth,
      org: opts.org,
    });

    var ignores = null;

    return (
      Promise.resolve()

        .then(config.loadAll)

        .then(() => {
          return dmcignore.load().then(function (lines) {
            ignores = lines;
          });
        })

        .then(() => {
          return sfClient.getClient(opts.oauth);
        })

        // load the index for the org
        .then((sfdcClient) => {
          client = sfdcClient;
          return map.autoLoad();
        })

        // search src/ for file matches
        .then(() => {
          if (timesBeingDeployed > 0) return Promise.resolve();
          logger.log("searching for local metadata");
          return getFiles({ globs: globs, ignores: ignores }).then(function (
            files
          ) {
            if (!files || files.length < 1) {
              throw new Error("no files for deployment found");
            }
            logger.log("deploying " + hl(files.length) + " metadata files");
            map.addFiles(files);
          });
        })

        .then(() => {
          if (map.getFilePathsForDeploy().length === 0) {
            return;
          }
          var deployMode = config.get("deploy_mode") || "dynamic";

          logger.log("deploy mode: " + deployMode);

          if (
            !map.requiresMetadataDeploy() &&
            !opts.meta &&
            deployMode !== "metadata" &&
            !opts.tests
          ) {
            logger.info("deploy api: " + hl("tooling"));
            return runToolingDeploy(map, client);
          } else {
            logger.info("deploy api: " + hl("metadata"));
            return runMetadataDeploy(map, client, opts).then(
              (timesBeingDeployed = 1)
            );
          }
        })
    );
  });
});

module.exports.cli = function (program) {
  program
    .command("deploy [globs...]")
    .description("deploy metadata to target org")
    .option("-o, --org <org>", "the Salesforce organization to use")
    .option("--coverage", "show code coverage for tests run")
    .option("--meta", "force deploy with metadata api")
    .option("--tests", "run all tests on deployment")
    .action(function (globs, opts) {
      opts.globs = globs;
      opts._loadOrg = true;
      return cliUtil.executeRun(run)(opts);
    });
};
