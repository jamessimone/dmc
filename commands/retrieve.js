var user = require("../lib/user");
var _ = require("lodash");
var logger = require("../lib/logger");
var hl = logger.highlight;
var cliUtil = require("../lib/cli-util");
var sfClient = require("../lib/sf-client");
var index = require("../lib/index");
var metaMap = require("../lib/metadata-map");
var async = require("async");
var Promise = require("bluebird");
var matching = require("../lib/matching");
var paths = require("../lib/paths");
var fs = require("../lib/fs");
var glob = require("glob");
var AdmZip = require("adm-zip");
var rimraf = require("rimraf");
var dmcignore = require("../lib/dmcignore");
var resolve = require("../lib/resolve");

var rimrafAsync = Promise.promisify(rimraf);

function getFilePaths(typeGroups, opts, client) {
  return new Promise(function (resolve, reject) {
    var iterator = function (types, cb) {
      types = _.map(types, function (t) {
        // when searching documents but not specifying a subfolder
        // we need to request a listMetadata on DocumentFolder
        // first and recursively call the iterator to return the
        // documents in the subfolder
        if (t.name === "Document" && !t.subFolder) {
          return { name: "DocumentFolder" };
        } else if (t.name === "EmailTemplate" && !t.subFolder) {
          return { name: "EmailFolder" };
        } else if (t.name === "Report" && !t.subFolder) {
          return { name: "ReportFolder" };
        } else if (t.name === "Dashboard" && !t.subFolder) {
          return { name: "DashboardFolder" };
        }

        return t;
      });

      client.meta
        .listMetadata({
          queries: _.map(types, function (t) {
            return {
              type: t.name,
              folder: t.subFolder,
            };
          }),
        })

        .then(function (res) {
          var promises = [];

          _(res)
            .flattenDeep()
            .each(function (md) {
              if (md.type === "DocumentFolder") {
                promises.push(
                  iteratorAsync([{ name: "Document", subFolder: md.fullName }])
                );
              } else if (md.type === "EmailFolder") {
                promises.push(
                  iteratorAsync([
                    { name: "EmailTemplate", subFolder: md.fullName },
                  ])
                );
              } else if (md.type === "ReportFolder") {
                promises.push(
                  iteratorAsync([{ name: "Report", subFolder: md.fullName }])
                );
              } else if (md.type === "DashboardFolder") {
                promises.push(
                  iteratorAsync([{ name: "Dashboard", subFolder: md.fullName }])
                );
              } else {
                promises.push(Promise.resolve(md));
              }
            })
            .value();

          return Promise.all(promises);
        })

        .then(function (res) {
          if (!res || !res.length) {
            return cb(null, null);
          }

          // create a regex to test for incompatible fileNames
          // returned from salesforce. See comments below...
          var re = new RegExp("^(" + _.map(types, "name").join("|") + ")\\/");

          var filePaths = _(res)
            .flattenDeep()
            .compact()
            .filter(function (r) {
              if (opts.all) return true;

              if (opts.ns) {
                return (
                  r.namespacePrefix &&
                  r.namespacePrefix.toLowerCase() === opts.ns.toLowerCase()
                );
              }

              return (
                _.isNull(r.namespacePrefix) ||
                _.isUndefined(r.namespacePrefix) ||
                r.namespacePrefix.length < 1
              );
            })
            .map(function (md) {
              // this is already turned into a string by recursion
              if (_.isString(md)) return md;

              // sometimes salesforce responds with a weird
              // filename like Workflow/My_Object.object when
              // all other workflows fall into a directory like
              // workflows/. This checks for those edge cases and
              // adjusts the folder
              if (re.test(md.fileName)) {
                var folder = _.find(types, { name: md.type }).folder;
                return "src/" + md.fileName.replace(re, folder + "/");
              }
              return "src/" + md.fileName;
            })
            .value();

          cb(null, filePaths);
        })
        .catch(function (err) {
          cb(err);
        });
    };

    var iteratorAsync = Promise.promisify(iterator);

    async.mapLimit(typeGroups, 5, iterator, function (err, res) {
      if (err) return reject(err);
      var files = _(res).compact().flattenDeep().uniq().value();
      resolve(files);
    });
  });
}

function clearSrcDir() {
  return new Promise(function (resolve, reject) {
    rimraf("src/*", function (err) {
      if (err) return reject(err);
      return resolve();
    });
  });
}

function unzipToTmp(zipBase64) {
  return new Promise(function (resolve, reject) {
    logger.log("unzipping to tmp dir: " + paths.dir.tmp);

    var zip = new AdmZip(new Buffer(zipBase64, "base64"));

    logger.log("extracting zip");

    zip.extractAllToAsync(paths.dir.tmp, true, function (err, res) {
      if (err) return reject(err);
      resolve();
    });
  });
}

function copyFiles(replace) {
  return new Promise(function (resolve, reject) {
    var tmpPkgContents;
    var copyOpts = {};
    var tmpPkgFile = paths.dir.tmp + "/unpackaged/package.xml";

    fs.readFileAsync(tmpPkgFile, { encoding: "utf8" })
      .then(function (result) {
        tmpPkgContents = result;
        if (!replace) return rimrafAsync(tmpPkgFile);
      })
      .then(function () {
        var tmpSrcDir = paths.dir.tmp + "/unpackaged/";
        var srcDir = process.cwd() + "/src/";
        return fs.copyAsync(tmpSrcDir, srcDir, copyOpts);
      })
      .then(function () {
        resolve();
      })
      .catch(function (err) {
        logger.error(err.message);
        reject(err);
      });
  });
}

function removeTmpDir() {
  return fs.existsAsync(paths.dir.tmp).then(function (exists) {
    if (exists) {
      logger.log("removing tmp directory");
      return fs.removeAsync(paths.dir.tmp);
    }
  });
}

var run = (module.exports.run = function (opts, cb) {
  return resolve(cb, function () {
    var client;

    if (!opts.globs || opts.globs.length === 0) {
      opts.globs = ["src/**/*"];
    }

    var map = metaMap.createMap({
      oauth: opts.oauth,
      org: opts.org,
    });

    var ignores = null;

    return Promise.resolve()

      .then(function () {
        return dmcignore.load().then(function (lines) {
          ignores = lines;
        });
      })

      .then(function () {
        return sfClient.getClient(opts.oauth);
      })

      .then(function (sfdcClient) {
        client = sfdcClient;
        return map.autoLoad();
      })

      .then(function () {
        var typeMatches = map.index.getTypesFromGlobs(opts.globs);
        // log out the matched directories
        logger.log("matching types");
        _.each(typeMatches, function (tm) {
          logger.list("matched type: " + tm.name);
        });
        // group the metadata into groups of 3 since that's the limit
        // in a single listMetadata call
        var grouped = _.chunk(typeMatches, 3);
        return getFilePaths(grouped, opts, client);
      })

      .then(function (fpaths) {
        if (!fpaths || fpaths.length < 1) {
          throw new Error("no files found for retrieve");
        }
        return matching.filterOnGlobs(fpaths, opts.globs, ignores);
      })

      .then(function (filteredPaths) {
        if (!filteredPaths || filteredPaths.length < 1) {
          throw new Error("no files found for retrieve");
        }
        map.addFiles(filteredPaths);

        var apiVersion = client.apiVersion.replace("v", "");

        var promise = client.meta.retrieveAndPoll({
          apiVersion: apiVersion,
          unpackaged: {
            version: apiVersion,
            types: map.createTypesArray(),
          },
        });

        promise.poller.on("poll", function (res) {
          logger.log("retrieve status: " + hl(res.status));
        });

        return promise;
      })

      .then(function (res) {
        return unzipToTmp(res.zipFile);
      })

      .then(function () {
        if (opts.replace) {
          logger.log("clearing src dir");
          return clearSrcDir();
        }
      })

      .then(function () {
        logger.log("merging files to src");
        return copyFiles(opts.replace);
      })

      .then(function () {
        logger.log("cleaning up temporary files");
        return removeTmpDir();
      })

      .then(function () {
        logger.success("retrieve successful");
      });
  });
});

module.exports.cli = function (program) {
  program
    .command("retrieve [globs...]")
    .description("retrieve metadata from target org")
    .option("-o, --org <org>", "the Salesforce organization to use")
    .option(
      "-r, --replace",
      "replace all local metadata with the retrieved metadata"
    )
    .option("-a, --all", "return all metadata including namespaced metadata")
    .option("-n, --ns <ns>", "return a specific namespace")
    .action(function (globs, opts) {
      opts.globs = globs;
      opts._loadOrg = true;
      return cliUtil.executeRun(run)(opts);
    });
};
