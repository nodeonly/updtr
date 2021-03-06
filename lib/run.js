"use strict";

var async = require("async");
var childProcess = require("child_process");
var filter = require("./filter");
var EventEmitter = require("./EventEmitter.js");

var defaultTestCmd = "npm test";

function sanitizeConfig(config) {
    config.reporter = config.reporter || Function.prototype;
    config.testCmd = config.testCmd || defaultTestCmd;
    config.exclude = config.exclude && config.exclude.split(",").map(function (name) {
        return name.trim();
    }) || [];
}

function run(config, done) {
    var emitter = new EventEmitter();
    var testCmd;
    var reporter;
    var cwd;

    function exec(cmd, cb) {
        childProcess.exec(cmd, { maxBuffer: Infinity, encoding: "utf8", cwd: config.cwd }, cb);
    }

    function finish(err) {
        emitter.removeAllListeners();
        done(err || null);
    }

    sanitizeConfig(config);

    reporter = config.reporter;
    cwd = config.cwd;
    testCmd = config.testCmd;

    if (typeof cwd !== "string") {
        throw new Error("Cannot run updtr: cwd missing");
    }

    reporter(emitter);

    emitter.emit("init", {
        cwd: config.cwd
    });
    exec("npm outdated --json --long --depth=0", function (err, stdout, stderr) {
        var outdated;
        var infos;
        var tasks;
        var modulesMissing;

        function createTask(info, index) {
            index++;

            return function (done) {
                var event = {
                    current: index,
                    total: tasks.length,
                    info: info,
                    testCmd: testCmd,
                    installCmd: installCmd = "npm i" + (config.registry ? (" --registry " + config.registry) : "")
                };
                var testStdout;
                var installCmd = event.installCmd + " " + info.name + "@" + info.updateTo + " " + info.saveCmd;

                if (config.saveExact) {
                    installCmd += " --save-exact";
                }

                emitter.emit("updating", event);

                async.series({
                    deleteOldVersion: async.apply(exec, "npm remove " + info.name + " " + info.saveCmd),
                    installNewVersion: async.apply(exec, installCmd),
                    emitTestingEvent: function (done) {
                        emitter.emit("testing", event);
                        setImmediate(done);
                    },
                    runTests: function runTests(callback) {
                        exec(testCmd, function (err, stdout, stderr) {
                            if (err) {
                                testStdout = stdout;
                                callback(err);
                                return;
                            }
                            callback(null, stdout, stderr);
                        });
                    }
                }, function (err) {
                    if (err) {
                        emitter.emit("rollback", event);
                        exec(event.installCmd + " " + info.name + "@" + info.current + " " + info.saveCmd + (config.saveExact ? " --save-exact" : ""), function (err) {
                            if (err) {
                                finish(err);
                                return;
                            }
                            emitter.emit("rollbackDone", event);
                            if (config.testStdout) {
                                event.testStdout = testStdout;
                                emitter.emit("testStdout", event);
                            }
                            done();
                        });
                        return;
                    }
                    emitter.emit("updatingDone", event);
                    done();
                });
            };
        }

        if (err) {
            finish(err);
            return;
        }

        if (!stdout) {
            emitter.emit("noop");
            finish();
            return;
        }

        outdated = JSON.parse(stdout);
        infos = Object.keys(outdated)
            .map(function (moduleName) {
                var info = outdated[moduleName];

                info.name = moduleName;
                info.saveCmd = info.type === "devDependencies" ? "--save-dev" : "--save";
                info.updateTo = config.wanted ? info.wanted : info.latest;

                return info;
            })
            .filter(filter(config));

        modulesMissing = infos.some(function (info) {
            return !info.current;
        });

        if (modulesMissing) {
            emitter.emit("modulesMissing");
            finish();
            return;
        }

        if (infos.length === 0) {
            emitter.emit("noop");
            finish();
            return;
        }

        emitter.emit("outdated", {
            infos: infos,
            total: infos.length
        });

        tasks = infos
            .map(function (info, index, outdatedModules) {
                return createTask(info, index, outdatedModules);
            });

        async.series(tasks, function (err) {
            if (err) {
                finish(err);
                return;
            }
            emitter.emit("finished");
            finish();
        });
    });
}

module.exports = run;
