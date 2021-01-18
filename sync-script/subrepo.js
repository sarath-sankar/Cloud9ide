#!/usr/bin/env node
var fs = require("fs");
var assert = require("assert");

var Path = require("path");
var spawn = require("child_process").spawn;
var rootDir = process.cwd();
var verbose = true;

/*** execFile ***/

function execFile(file, args, options, callback) {
    var child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        gid: options.gid,
        uid: options.uid,
        windowsVerbatimArguments: !!options.windowsVerbatimArguments
    });

    var encoding;
    var _stdout;
    var _stderr;
    if (options.encoding !== 'buffer' && Buffer.isEncoding(options.encoding)) {
        encoding = options.encoding;
        _stdout = '';
        _stderr = '';
    }
    else {
        _stdout = [];
        _stderr = [];
        encoding = null;
    }
    var killed = false;
    var exited = false;
    var ex = null;

    function exithandler(code, signal) {
        if (exited) return;
        exited = true;
        if (!callback) return;
        // merge chunks
        var stdout;
        var stderr;
        if (!encoding) {
            stdout = Buffer.concat(_stdout);
            stderr = Buffer.concat(_stderr);
        }
        else {
            stdout = _stdout;
            stderr = _stderr;
        }

        if (ex) {
            // Will be handled later
        }
        else if (code === 0 && signal === null) {
            callback(null, stdout, stderr);
            return;
        }

        var cmd = file;
        if (args.length !== 0)
            cmd += ' ' + args.join(' ');

        if (!ex) {
            ex = new Error('Command failed: ' + cmd + '\n' + stderr);
            ex.killed = child.killed || killed;
            ex.code = code;
            ex.signal = signal;
        }

        ex.cmd = cmd;
        callback(ex, stdout, stderr);
    }

    function errorhandler(e) {
        ex = e;
        child.stdout.destroy();
        child.stderr.destroy();
        exithandler();
    }

    child.stdout.addListener('data', options.onStdout || function(chunk) {
        _stdout += chunk;
    });

    child.stderr.addListener('data', function(chunk) {
        _stderr += chunk;
    });

    if (encoding) {
        child.stderr.setEncoding(encoding);
        child.stdout.setEncoding(encoding);
    }

    child.addListener('close', exithandler);
    child.addListener('error', errorhandler);

    return child;
}

function forEachSeries(array, handler, cb) {
    var i = 0, el;
    var nested = false, callNext = true, error = null;
    loop();

    function loop(err, result) {
        if (err) error = err;
        while (callNext && !nested) {
            callNext = false;

            if (error)
                i = array.length;

            if (i >= array.length)
                return cb && cb(err, result);
            el = array[i];
            i++;

            nested = true;
            handler(el, loop);
            nested = false;
        }
        callNext = true;
    }
}

function series(fnArray, cb) {
    forEachSeries(fnArray, function(fn, next) {
        if (fn) fn(next);
        else next();
    }, cb);
}

function parForEach(maxActive, items, handler, cb) {
    var pending = items;
    var active = 0, nested = false, index = 0;
    function takeFromQueue() {
        nested = true;
        while (active < maxActive) {
            var el = pending[index++];
            if (!el)
                break;
            active++;
            handler(el, next);
        }
        nested = false;
    }
    function next(e) {
        active--;
        if (index < pending.length || active) {
            nested || takeFromQueue();
        } else {
            cb && cb();
        }
    }
    takeFromQueue();
}

var async = {
    forEachSeries: forEachSeries,
    series: series
};


/*** git helpers ***/
var EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // hash of empty root tree

function git(args, cb, env, onStdout) {
    if (verbose)
        console.log("git " + args.join(" "));
    return execFile("git", args, {
        encoding: "utf8",
        env: env,
        onStdout: onStdout
    }, function(e, r) {
        if (e) console.log(e);
        if (verbose > 1)
            console.log(r.substr(0, 1000));
        cb(e, r.trim());
    });
}

function die(reason) {
    console.error(reason);
    process.exit(1);
}

function revList(options, cb) {
    var args = ["log", "--topo-order", "--date=raw"];
    if (options.boundary != false) args.push("--boundary");
    if (options.logOptions) args.push.apply(args, options.logOptions);
    args.push('--pretty=format:' + (options.format || "%H %T %P"));
    var l = args.length;
    options.include.forEach(function(c) { c && args.push(c); });
    options.exclude.forEach(function(c) { c && args.push("^" + c); });
    if (l == args.length)
        return cb(null, "");
    if (args[args.length - 1] == "^" + args[args.length - 2])
        args[args.length - 1] = "-1";
    if (options.path || options.paths)
        args.push("--");
    if (options.path)
        args.push(options.path);
    if (options.paths)
        args.push.apply(args, options.paths);
    git(args, cb);
}

function revParse(revs, cb) {
    git("rev-parse --revs-only".split(" ").concat(revs), cb);
}

function copy_commit(opts, cb) {
    git(["log", "-1", "--pretty=format:%an %ae %ad %cn %ce %cd %B ".replace(/ /g, "%x00"), opts.oldSha], function(e, r) {
        var lines = r.split("\x00");
        var env = {
            GIT_AUTHOR_NAME: lines[0],
            GIT_AUTHOR_EMAIL: lines[1],
            GIT_AUTHOR_DATE: lines[2],
            GIT_COMMITTER_NAME: lines[3],
            GIT_COMMITTER_EMAIL: lines[4],
            GIT_COMMITTER_DATE: lines[5],
        };
        var body = lines[6];
        if (opts.filterMessage)
            body = opts.filterMessage(body);
        var parents = opts.parents;
        var args = ["commit-tree", opts.tree];
        parents.forEach(function(p) {
            args.push("-p", p);
        });
        var proc = git(args, function(e, r) {
            cb(e, r.trim());
        }, env);
        proc.stdin.write(body);
        proc.stdin.end();
    });
}

function commitTree(opts, cb) {
    var date = new Date + "";
    var env = {
        GIT_AUTHOR_NAME: "subrepoBot",
        GIT_AUTHOR_EMAIL: "subrepoBot@c9.io",
        GIT_AUTHOR_DATE: date,
    };
    env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
    env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOREMAIL;
    env.GIT_COMMITTER_DATE = env.GIT_AUTHOR_DATE;

    var parents = opts.parents || [];
    var args = ["commit-tree", opts.tree];
    parents.forEach(function(p) {
        p && args.push("-p", p);
    });
    var proc = git(args, function(e, r) {
        cb(e, r.trim());
    }, env);
    proc.stdin.write(opts.message);
    proc.stdin.end();
}

function createBlob(str, cb) {
    var proc = git("hash-object -w --stdin".split(" "), function(e, r) {
        cb(e, r.trim());
    });
    proc.stdin.write(str);
    proc.stdin.resume();
    proc.stdin.end();
}


function startFastImport() {
    var fastImport = git(["fast-import", "--force"], function(e, r) {
        var m = e && e.message && e.message.match(/\.git.+/);
        if (m) console.log(fs.readFileSync(m[0], "utf8"), e, r);
        fastImport.callback && fastImport.callback();
    }, {}, function(data) {
        // console.log(">>>" + data);
        var m = data.match(/^040000 tree ([^\s]+)\s|^([\da-z]{40})(?:$|\n)|^(missing)/);
        var cb = fastImport.callback;
        fastImport.callback = null;
        cb && cb(m && m[3], m && (m[1] || m[2]));
        // git(["update-ref", "-d",  fullPrefix + "/tmp/1"], function() {
        //     cb && cb(m, m[1]);
        // });
    });
    fastImport.tmpBranchCounter = 10;

    fastImport.write = function(str, cb) {
        // console.log("<<<" + str);
        if (typeof cb != "function" && cb) throw new Error("not a callback");
        if (cb && fastImport.callback) throw new Error("can't overwrite the callback");
        fastImport.callback = cb;
        fastImport.stdin.write(str);
    };

    fastImport.end = function(cb) {
        if (typeof cb != "function" && cb) throw new Error("not a callback");
        if (cb && fastImport.callback) throw new Error("can't overwrite the callback");
        fastImport.callback = cb;
        fastImport.stdin.end();
    };

    fastImport.startTmpCommit = function(message, base) {
        message = message || "tmp";
        fastImport.stdin.write(["commit " + fullPrefix + "/tmp/1",
            // "mark :1",
            "author tmp <tmp@tmp.com> 1000000000 +0000",
            "committer tmp <tmp@tmp.com> 1000000000 +0000",
            "data " + Buffer.byteLength(message),
            message,
            ""
        ].join("\n"));
        if (base)
            fastImport.stdin.write("from " + base + "\n");
    };
    fastImport.startCommit = function(mark, message, author, committer, parents) {
        var hasParents = parents && parents[0];
        if (!hasParents) {
            console.log(fastImport.tmpBranchCounter)
            console.log(message);
            fastImport.tmpBranchCounter++;
        }
        fastImport.stdin.write(["commit " + fullPrefix + "/tmp-counter/" + fastImport.tmpBranchCounter,
            "mark :" + mark,
            author,
            committer,
            "data " + Buffer.byteLength(message),
            message,
            "",
        ].join("\n"));
        if (hasParents) {
            fastImport.stdin.write("from " + parents[0] + "\n");
            for (var i = 1; i < parents.length; i++) {
                fastImport.stdin.write("merge " + parents[i] + "\n");
            }
        }
    };

    return fastImport;
}

function readBytes(str, start, bytes) {
    // returns the byte length of an utf8 string
    var consumed = 0;
    for (var i = start; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code < 0x7f) consumed++;
        else if (code > 0x7f && code <= 0x7ff) consumed += 2;
        else if (code > 0x7ff && code <= 0xffff) consumed += 3;
        if (code >= 0xD800 && code <= 0xDBFF) { i++; consumed += 1} // leading surrogate
        if (consumed >= bytes) { i++; break; }
    }
    if (Buffer.byteLength(str.slice(start, i)) != consumed)
        throw new Error(":( utf");
    return { bytes: consumed, length: i - start };
}

function startBatchReader() {
    var received = "", header = "";
    var expectedBytes = 0, offset = 0;
    var reader = git(["cat-file", "--batch"], function(e, r) {
        reader.callback && reader.callback(e, r);
    }, null, function(data) {
        //console.log(data)
        received += data;
        // console.log(expectedBytes, received.length, header, "]]]]]]]]]]]]]]")
        if (!expectedBytes && !header) {
            var i = received.indexOf("\n");
            if (i != -1) {
                header = received.substring(0, i);
                received = received.substr(i + 1);
                var size = header.split(" ").pop();
                expectedBytes = parseInt(size, 10) + 1 || 0;
                // console.log(expectedBytes, received.length, header, "]]]]]]]]]]]]]]---")
            }
        }
        if (expectedBytes) {
            var result = readBytes(received, offset, expectedBytes);
            expectedBytes -= result.bytes;
            offset += result.length;
        }
        if (expectedBytes <= 0 && header) {
            var content = received.substring(0, offset - 1);
            received = received.substr(offset);
            offset = expectedBytes = 0;
            // console.log(expectedBytes, received.length, header, "]]]]]]]]]]]]]]>>>")
            reader.callback && reader.callback(null, content, header);
            header = "";
            takeQueue();
        }
    });
    function takeQueue() {
        reader.callback = null;
        if (reader.queue.length)
            reader.get(reader.queue.shift(), reader.queue.shift());
    }
    reader.queue = [];
    reader.get = function(str, cb) {
        // console.log(str);
        if (reader.callback)
            return reader.queue.push(str, cb);
        reader.callback = cb;
        if (str == null)
            return reader.stdin.end();
        reader.stdin.write(str + "\n");
    };
    reader.end = function(cb) {
        if (typeof cb != "function" && cb) throw new Error("not a callback");
        reader.get(null, cb);

    };
    return reader;
}

function gitCatFile(name, cb) {
    if (!gitCatFile.batchReader)
        gitCatFile.batchReader = startBatchReader();
    gitCatFile.batchReader.get(name, cb);
}

/*** cache ***/

function readCommitMap(name, cb) {
    gitCatFile(prefix + "/index:" + name + "/commitMap.txt", function(e, r) {
        if (e) return cb(e);
        var map = Object.create(null);
        r.split("\n").forEach(function(x) {
            if (!x) return;
            var entry = x.split(":");
            map[entry[0]] = entry[1];
        });
        cb(e, map);
    });
}

function saveCommitMap(name, map, cb) {
    var str = Object.keys(map).map(function(x) {
        return x + ":" + map[x];
    }).join("\n");

    var hash, parent, parentTree, tree, commit;
    async.series([
        function(next) {
            createBlob(str, function(e, r) {
                hash = r;
                next();
            });
        },
        function(next) {
            revParse(prefix + "/index", function(e, r) {
                parent = r;
                next();
            });
        },
        function(next) {
            revParse(prefix + "/index^{tree}", function(e, r) {
                parentTree = r;
                next();
            });
        },
        function(next) {
            var fastImport = startFastImport();
            fastImport.startTmpCommit();
            fastImport.write("M 040000 " + (parentTree || EMPTY_TREE) + " \n");
            fastImport.write("M 100644 " + hash + " " + name + "/commitMap.txt" + "\n");
            fastImport.write("ls \"\"\n", function(e, r) {
                tree = r;
                fastImport.stdin.write("\n");
                fastImport.end(function(e) {
                    next();
                });
            });
        },
        function(next) {
            if (tree == parentTree)
                return next();
            commitTree({
                tree: tree,
                parents: [parent],
                message: ["subtree update ", name, " to ", map.last,
                    "\n      ", map[map.last]].join(""),
            }, function(e, r) {
                commit = r.trim();
                next();
            });
        },
        function(next) {
            if (!commit)
                return cb();
            // git update-ref
            git(["update-ref", fullPrefix + "/index", commit], function(e, r) {
                cb();
            });
        }
    ]);
}

/*** remapHistory ***/
function remapHistory(options, callback) {
    // verbose && console.log(options);
    var remapTree = options.remapTree;
    var startRev = options.startRev;
    var endRev = options.endRev;
    var cachedRev = options.cachedRev;
    var commitMap = options.commitMap;

    var oldCommits = {};
    var newCommits = {};
    var commitList = [];

    var fastImport, commits, treeMap;
    async.series([
        function(next) {
            if (cachedRev && commitMap.last) return next();
            cachedRev = commitMap.lastChecked = commitMap.last;
            // get the list of commits already in the new branch
            revList({
                format: "%H %T %P %cd %cn %ce %ad %an %ae %B  ".replace(/ /g, "%x00"),
                exclude: [commitMap.first],
                include: [commitMap.last],
                path: ""
            }, function(e, r) {
                var branch = parseLog(r);
                if (commitMap.last == commitMap.first) {
                    // var parent = branch.bySha[commitMap.last];
                    // parent.parents.forEach(function(p) {
                    //     commitMap[p] = commitMap[commitMap.last];
                    // });
                    return next();
                }
                var cm = branch.list.slice().reverse();
                // treeMap = {};
                // fastImport = startFastImport();
                // var lsTree = function(tree, dir, cb) {
                //     console.log(tree);
                //     fastImport.write("ls " + tree + " \"" + dir + "\"\n", cb);
                // };
                // async.forEachSeries(cm, function(commit, next) {
                //     lsTree(commit.sha, dir, function(e, r) {
                //         commit.tt = r;
                //         var sha1 = commitMap[commit.sha]
                //         if (sha1 && !treeMap[sha1]) {
                //             lsTree(sha1, "", function(e, r) {
                //                 treeMap[sha1] = r;
                //                 next();
                //             })
                //         } else
                //             next();
                //     });
                // }, function() {
                //     fillGaps()
                //     next();
                // });
                fillGaps();
                next();
                function fillGaps() {
                    cm.forEach(function(commit) {
                        if (commitMap[commit.sha]) {
                            commit.mapTo = commitMap[commit.sha];
                        } else {
                            var parent;
                            if (commit.parents.length == 1) {
                                parent = branch.bySha[commit.parents[0]];
                            } else {
                                commit.parents.forEach(function(p) {
                                    if (commitMap[p]) {
                                        var p1 = branch.bySha[p];
                                        if (commit.tree == p1.tree) {
                                            parent = p1;
                                        }
                                    }
                                });
                            }

                            commitMap[commit.sha] != parent && commitMap[parent.sha];

                            // if (commit.tt != treeMap[commitMap[commit.sha]]) {
                            //     console.log(commit)
                            //     console.log(treeMap[commitMap[commit.parents[0]]])
                            //     console.log(treeMap[commitMap[commit.parents[1]]])
                            //     console.log(branch.bySha[commit.parents[1]])
                            //     console.log(branch.bySha[commit.parents[1]])
                            //     // process.exit(1)
                            // }
                        }
                    });
                }
            });
        },

        function(next) {
            // get the list of commits already in the new branch
            revList({
                format: "%H %T",
                exclude: [commitMap[startRev]],
                include: [commitMap[commitMap.last], commitMap[endRev], commitMap[cachedRev]]
            }, function(e, r) {
                assert(!e);
                r && r.split("\n").forEach(function(line, next) {
                    var parts = line.split(" ");
                    var sha = parts[0];
                    var tree = parts[1];
                    assert(tree, parts);
                    newCommits[sha] = {
                        sha: sha,
                        tree: tree,
                    };
                });
                next();
            });
        },
        function(next) { // simplify
            revList({
                format: "%H %P",
                exclude: [startRev, cachedRev],
                include: [endRev]
            }, function(e, r) {
                var commits = r.split("\n").reverse();
                var connectedCommits = {};
                commits.forEach(function(line) {
                    var parents = line.split(" ");
                    var sha = parents.shift();
                    if (!sha)
                        return;
                    var commit = oldCommits[sha] = {
                        sha: sha,
                        parents: parents,
                    };
                    // console.log(sha.substr(0, 10), cachedRev.substr(0, 10), endRev.substr(0, 10))
                    if (commitMap[sha] && newCommits[commitMap[sha]]) {
                        commit.newTree = newCommits[commitMap[sha]].tree;
                        assert(commit.newTree, commit);
                        return;
                    }
                    if (cachedRev) {
                        var p = commit.parents[0];
                        if (!commitMap[p] && !connectedCommits[p])
                            commit.isMainLine = false;
                        commit.parents = commit.parents.filter(function(p) {
                            return commitMap[p] || connectedCommits[p];
                        });
                        if (commit.parents.length)
                            connectedCommits[commit.sha] = 1;
                        else
                            return;
                    }
                    commitList.push(commit);
                });

                var sha = endRev;
                while (sha) {
                    var commit = oldCommits[sha];
                    sha = commit && commit.isMainLine != false && commit.parents[0];
                    if (commit)
                        commit.isMainLine = true;
                }

                next();
            });
        },

        // function(next) {
        //     readCommitMap("core_xx", function(e, map) {
        //         treeMap = map || {};
        //         next();
        //     });
        // },
        function(next) {
            fastImport = startFastImport();

            var state = {
                oldCommits: oldCommits,
                newCommits: newCommits,
                commitMap: commitMap,
                fastImport: fastImport
            };
            var dir = options.dir;
            var lsTree = function(tree, baseTree, cb, state) {
                verbose && console.log(tree);
                fastImport.write("ls " + tree + " \"" + dir + "\"\n", cb);
            };
            // if (options.mode == "export") {
                remapTree = dir ? lsTree : createPublicTree;
            // }
            // console.log(commitMap);
            async.forEachSeries(commitList, function(commit, next) {
                // if (!commit.newTree && xxTreeMap[commit.sha])
                //     commit.newTree = xxTreeMap[commit.sha];
                if (commit.newTree || commitMap[commit.sha])
                    return next();
                remapTree(commit.sha, "", function(e, r) {
                    assert((!e && r) || (e == "missing"), [e, r, commit]);
                    commit.newTree = r;
                    // xxTreeMap[commit.sha] = commit.newTree;

                    next();
                }, state);
            }, next);
        },
        // function(next) {
        //     saveCommitMap("core_xx", xxTreeMap,  function() {
        //         next();
        //     });
        // },

        function(next) {
            fastImport.stdin.end(function() {
                fastImport = null;
                next();
            });
        },
        function(next) {
            // console.log(commitList)
            async.forEachSeries(commitList, function(commit, next) {
                if (commitMap[commit.sha])
                    return next();
                var tree = commit.newTree;
                var newParents = [];
                var treeSameParents = [];
                commit.parents.forEach(function(p, i) {
                    var newParentTree;
                    if (commitMap[p] && newCommits[commitMap[p]]) {
                        var mapTo = newCommits[commitMap[p]];
                        if (!mapTo)
                            console.log(p, commitMap[p]);

                        newParentTree = mapTo.tree;
                        newParents[i] = commitMap[p];
                    } else {
                        var parentCommit = oldCommits[p];
                        if (!parentCommit) return console.log(p);
                        newParentTree = parentCommit.newTree;
                        newParents[i] = commitMap[parentCommit.sha];
                    }
                    if (newParentTree == tree)
                        treeSameParents[i] = oldCommits[p];
                });

                // if (!commit.isMainLine)
                    treeSameParents = treeSameParents.filter(Boolean);
                if (treeSameParents[0]) {
                    assert(commit.sha && commitMap[treeSameParents[0].sha], [treeSameParents, commit]);
                    commitMap[commit.sha] = commitMap[treeSameParents[0].sha];
                    return next();
                }

                newParents = newParents.filter(Boolean);

                if (!newParents.length) {
                    console.log(treeSameParents, commit);
                }

                if (false && commit.parents.length && !newParents.length) {
                    var initial = commitMap.initial && commitMap[commitMap.initial];
                    if (!initial) {
                        var overwriteMessage = "initial commit";
                        commitMap.initial = commit.sha;
                    } else {
                        newParents = [initial];
                    }
                }

                if (!commit.newTree) {
                    if (verbose)
                        console.log("ignoring commit without a tree " + commit.sha);
                    return next();
                }

                copy_commit({
                    oldSha: commit.sha,
                    tree: commit.newTree,
                    parents: newParents,
                    filterMessage: overwriteMessage ? function(msg) {
                        return overwriteMessage;
                    } : function(msg) {
                        return msg.replace(/([+#])(\d+)/g, function(x, t, n) {
                                return (t == "+" ? "#" : "+") + n;
                            })
                            .replace(/\b([\da-f]{10,})\b/g, function(sha) {
                                return commitMap[sha] || sha;
                            });
                    }
                }, function(e, r) {
                    verbose && console.log(commit);
                    verbose && console.log(commit.sha, r, newParents);

                    commitMap[commit.sha] = r;
                    commitMap.last = commit.sha;
                    next();
                });
            }, function(e, r) {
                // console.log(commitMap);
                next();
            });
        },
        function(next) {
            // console.log(commitMap.last, endRev);
            commitMap.lastChecked = endRev;
            git(["update-ref", fullPrefix + "/branches/" + commitMap.name, commitMap[endRev]], function(e, r) {
                if (!/no-write/.test(options.cache))
                    saveCommitMap(commitMap.name, commitMap, next);
                else
                    next();
            });
        }
    ], callback);

}

/*** main commands ***/

exports.cmd_split = function(options, cb) {
    var commitMap;
    var from = options.from;
    var to = options.to;
    var dir = options.dir;
    var name = options.name;

    async.series([
        function(next) {
            readCommitMap(name, function(e, map) {
                if (!map || options.cache === false) {
                    map = {};
                    map.first = from;
                }
                commitMap = map;
                commitMap.name = name;
                next();
            });
        },
        function(next) {
            revParse([from || commitMap.initial, to || "origin/master"], function(e, r) {
                r = r.split("\n");
                from = r[0];
                to = r[1];

                if (!from || !to)
                    die("ambiguous from to arguments " + r);
                next();
            });
        },
        function(next) {
            remapHistory({
                startRev: commitMap.first,
                endRev: to,
                cachedRev: commitMap.lastChecked,
                commitMap: commitMap,
                dir: dir,
                mode: options.mode
            }, next);
        },
        function(next) {
            verbose && console.log(commitMap.last, to);
            git(["update-ref", fullPrefix + "/branches/" + name, commitMap[to]], function(e, r) {
                if (!/no-write/.test(options.cache))
                    saveCommitMap(name, commitMap, next);
                else
                    next();
            });
        }
    ], cb);
};

exports.cmd_checkIgnoreList = function(options, cb) {
    git("ls-tree --name-only -r HEAD".split(" "), function(e, r) {
        if (e) die("couldn't read HEAD tree");
        getPrivateFileList(r, sdkConfig.privatFileMap, "strict");
        cb && cb();
    });
};

exports.cmd_sync_remote = function(options, callback) {
    var name = options.name;
    var remote = options.remoteBranch || fullPrefix + "/remotes/" + name;
    var mainBranch = "refs/remotes/origin/master";
    var mode = "import";
    var dir = options.dir;
    var path = dir ? dir : ".";
    var t = Date.now();
    var originBranch, targetBranch;

    var unsynced = [], fastImport, hasCommonCommit;
    var commitMap;
    async.series([
        // get commits in new and old branches and try to match them together
        function(next) {
            var t = Date.now();
            revList({
                format: "%H %T %P %cd %cn %ce %ad %an %ae %B  ".replace(/ /g, "%x00"),
                exclude: [],
                include: [remote],
                path: ""
            }, function(e, r) {
                originBranch = parseLog(r);
                console.log(t - Date.now());
                next();
            });
        },
        function(next) {
            var t = Date.now();
            revList({
                format: "%H %T %P %cd %cn %ce %ad %an %ae %B  ".replace(/ /g, "%x00"),
                exclude: [],
                include: [mainBranch],
                path: path,
                logOptions: ["--full-history"]
            }, function(e, r) {
                targetBranch = parseLog(r);
                console.log(t - Date.now());
                next();
            });
        },
        function(next) {
            originBranch.list.forEach(function(commit) {
                if (!targetBranch.byId[commit.commitData]) {
                    unsynced.push(commit);
                } else {
                    hasCommonCommit = true;
                    commit.mapTo = targetBranch.byId[commit.commitData];
                }
            });
            originBranch.list.forEach(function(commit) {
                if (!commit.mapTo) return;
                var pending = commit.parents.slice();
                for (var i = 0; i < pending.length; i++) {
                    var p = pending[i];
                    var parent = originBranch.bySha[p];
                    if (parent && !parent.mapTo) {
                        var targetParentSha = commit.mapTo.parents[0];
                        parent.mapTo = targetBranch.bySha[targetParentSha];
                        if (parent.parents) {
                            pending.push.apply(pending, parent.parents);
                        }
                    }
                }
            });
            unsynced = unsynced.filter(function(commit) {
                return !commit.mapTo;
            });

            next();
        },
        function(next) {
            if (!hasCommonCommit) unsynced.length = 0;
            next();
        },
        // if there are new commits in the subrepo branch lift them into master
        function(next) {
            fastImport = startFastImport();

            var commits = unsynced.reverse();
            var state = {};

            state.fastImport = fastImport;
            var remapTree = dir ? function(tree, baseTree, cb, state) {
                fastImport.startTmpCommit();
                fastImport.write("M 040000 " + baseTree + " \n");
                fastImport.write("ls " + tree + " \"\"\n", function(e, r) {
                    fastImport.write("M 040000 " + r + " " + dir + "\n");
                    fastImport.write("ls \"\"\n");
                    fastImport.write("\n", cb);
                });
            } : function(tree, baseTree, cb, state) {
                git(["ls-tree", "-r", tree], function(e, r) {
                    fastImport.startTmpCommit();
                    fastImport.stdin.write("M 040000 " + baseTree + " \n");
                    r = r.replace(/\t/g, " ").replace(/(\n|^)(\d+) \w+ /g, "$1M $2 ") + "\n";
                    r = r.replace(/^M \d+ \w+ package.json\n/gm, "");
                    fastImport.write(r);
                    fastImport.write("ls \"\"\n");
                    fastImport.write("\n", cb);
                });
            };

            if (mode == "export") {
                var lsTree = function(tree, baseTree, cb, state) {
                    verbose && console.log(tree);
                    fastImport.write("ls " + tree + " \"" + dir + "\"\n", cb);
                };
                remapTree = dir ? lsTree : createPublicTree;
            }

            async.forEachSeries(commits, function(commit, next) {
                if (!commit.fistParent) {
                    var parentSha = commit.parents[0];
                    commit.fistParent = originBranch.bySha[parentSha];
                }
                if (!commit.fistParent) return next();
                var baseTree = commit.fistParent.newTree;
                if (!baseTree) {
                    baseTree = commit.fistParent.newTree = commit.fistParent.mapTo.tree;
                    assert(baseTree, commit);
                }
                remapTree(commit.sha, baseTree, function(e, r) {
                    assert(r && !e, [e, r, commit]);
                    commit.newTree = r;
                    next();
                }, state);
            }, next);
        },
        function(next) {
            fastImport.end(function() {
                fastImport = null;
                next();
            });
        },
        // create merge branch if needed
        function(next) {
            async.forEachSeries(unsynced, function(commit, next) {
                var tree = commit.newTree;
                var newParents = [];
                commit.parents.forEach(function(p) {
                    var parentCommit = originBranch.bySha[p];
                    if (!parentCommit || !parentCommit.newTree)
                        return;
                    var parentTree = parentCommit.newTree;
                    if (parentTree == tree && !commit.mapTo && commit.i) {
                        commit.mapTo = parentCommit.mapTo;
                        return;
                    }
                    newParents.push(parentCommit.mapTo.sha);
                });

                if (commit.mapTo)
                    return next();

                if (false && commit.parents.length && !newParents.length) {
                    var initial = commitMap.initial && commitMap[commitMap.initial];
                    if (!initial) {
                        var overwriteMessage = "initial commit";
                        commitMap.initial = commit.sha;
                    } else {
                        newParents = [initial];
                    }
                }

                if (!commit.newTree) {
                    if (verbose)
                        console.log("ignoring commit without a tree " + commit.sha);
                    return next();
                }

                copy_commit({
                    oldSha: commit.sha,
                    tree: commit.newTree,
                    parents: newParents,
                    filterMessage: overwriteMessage ? function(msg) {
                        return overwriteMessage;
                    } : function(msg) {
                        return msg.replace(/([+#])(\d+)/g, function(x, t, n) {
                                return (t == "+" ? "#" : "+") + n;
                            })
                            .replace(/\b([\da-f]{10,})\b/g, function(sha) {
                                var orig = originBranch.bySha[sha];
                                return orig && orig.mapTo && orig.mapTo.sha || sha;
                            });
                    }
                }, function(e, r) {
                    // verbose && console.log(commit);
                    verbose && console.log(commit.sha, "|", r, newParents);

                    commit.mapTo = {
                        sha: r,
                        tree: commit.newTree,
                    };
                    next();
                });
            }, function(e, r) {
                // console.log(commitMap);
                next();
            });
        },
        function(next) {
            if (!unsynced[unsynced.length - 1]) return next();
            var newSha = unsynced[unsynced.length - 1].mapTo.sha;
            var branchName = options.mergeBranch || (fullPrefix + "/merge/" + name);
            git(["update-ref", branchName, newSha], function(e, r) {
                next();
            });
        },
        // fill commit map for other commands
        function(next) {
            readCommitMap(name, function(e, map) {
                if (!map || options.cache === false) {
                    map = {};
                }
                commitMap = map;
                commitMap.name = name;

                originBranch.list.slice().reverse().forEach(function(commit) {
                    if (commit.mapTo) {
                        var sha = commit.mapTo.sha;
                        if (!commitMap[sha]) {
                            assert(commit.sha, commit);
                            commitMap[sha] = commit.sha;
                            commitMap.last = sha;
                            if (!commitMap.first)
                                commitMap.first = commitMap.last;
                            if (!commitMap.initial && !commit.parents.length)
                                commitMap.initial = sha;
                        }
                    }
                });

                next();
            });
        },
        function(next) {
            if (!/no-write/.test(options.cache))
                saveCommitMap(name, commitMap, next);
            else
                next();
        }
    ], callback);
};

exports.cmd_squash = function(options, callback) {
    var name = options.name;
    var remote = options.remoteBranch || fullPrefix + "/remotes/" + name;
    var local = "refs/heads/master";
    var dir = options.dir;
    var path = dir ? dir : ".";
    var t = Date.now();

    var fastImport = startFastImport();
    function remapTree(tree, baseTree, cb, state) {
        fastImport.startTmpCommit();
        fastImport.write("M 040000 " + baseTree + " \n");
        fastImport.write("ls " + tree + " \"\"\n", function(e, r) {
            fastImport.write("M 040000 " + r + " " + dir + "\n");
            fastImport.write("ls \"\"\n");
            fastImport.write("\n", cb);
        });
    }
    var localTree, commit, newSha;
    async.series([
        function(next) {
            revParse([remote, local, local + "^{tree}"], function(e, r) {
                if (e) return console.log(name);
                r = r.split("\n");
                remote = r[0];
                local = r[1];
                localTree = r[2];
                next();
            });
        },
        function(next) {
            var t = Date.now();
            revList({
                format: "%H %T %P %cd %cn %ce %ad %an %ae %B  ".replace(/ /g, "%x00"),
                exclude: [],
                include: [remote],
                boundary: false,
                logOptions: ["-n", 1]
            }, function(e, r) {
                var targetBranch = parseLog(r);
                commit = targetBranch.list[0];
                next();
            });
        },
        function(next) {
            remapTree(commit.sha, localTree, function(e, r) {
                assert(r && !e, [e, r, commit]);
                commit.newTree = r;
                next();
            });
        },
        function(next) {
            copy_commit({
                oldSha: commit.sha,
                tree: commit.newTree,
                parents: [local],
            }, function(e, r) {
                newSha = r;
                next();
            });
        },
        function(next) {
            fastImport.end(function() {
                fastImport = null;
                next();
            });
        },
        function(next) {
            var branchName = options.mergeBranch || (fullPrefix + "/merge/" + name);
            git(["update-ref", branchName, newSha], function(e, r) {
                next();
            });
        },
    ], callback);
};

/*** filtering for the root repo ***/

function getPrivateFileList(filelist, ignoreMap, strict) {
    var x = {};
    var root = {};
    filelist.split("\n").map(function(p) {
        if (p[0] == '"')
            p = p.slice(1, -1);
        var parts = p.split("/");
        var node = root;
        parts.forEach(function(p, i) {
            if (i == parts.length - 1) {
                node[p] = 1;
            } else {
                p = p + "/";
                if (!node[p])
                    node[p] = {};
                node = node[p];
            }
        });
    });
    function addPaths(base, ignoreMap, files) {
        // console.log(ignoreMap, files)
        var pattern = ["", ""];
        var unmatched = [];
        Object.keys(ignoreMap).forEach(function(p) {
            if (p.slice(-1) == "*") {
                var v = ignoreMap[p];
                if (v == 0 || v == 1) {
                    if (pattern[v]) pattern[v] += "|";
                    pattern[v] += "^" + p.replace(/\*/g, ".*");
                } else {
                    die(red + "ERROR: " + noColor + "* patterns must have value of 0 or 1"
                        + "\n value of " + p + " is " + ignoreMap[p]);
                }
                return;
            }
            if (ignoreMap[p] == 0) {
                x[base + p] = 1;
            } else if (ignoreMap[p] == 1) {
                if (!files[p])
                    unmatched.push(p);
            } else if (typeof ignoreMap[p] == "object") {
                addPaths(base + p, ignoreMap[p], files[p] || {});
            }
            delete files[p];
        });
        var rest = Object.keys(files);
        pattern[0] = pattern[0] && new RegExp(pattern[0], "i");
        pattern[1] = pattern[1] && new RegExp(pattern[1], "i");

        if (rest.length && unmatched.length && strict) {
            unmatched.forEach(function(x) {
                if (files[x + ".js"])
                    pattern = [];
            });
        }

        if (pattern[1]) {
            rest = rest.filter(function(p) {
                return !pattern[1].test(p);
            });
        }

        if (pattern[0]) {
            rest = rest.filter(function(p) {
                if (pattern[0].test(p)) {
                    x[base + p] = 1;
                } else {
                    return true;
                }
            });
        }

        if (rest.length && !strict) {
            console.log("ignoring " + rest);
            rest.forEach(function(p) {
                x[base + p] = 1;
            });
        } else if (rest.length) {
            var red = "\x1b[01;31m";
            var magenta = "\x1b[01;35m";
            var noColor = "\x1b[0m";
            die(red + "ERROR: " + noColor + "status of files " + magenta + JSON.stringify(rest) + noColor
                + "\n    " + "in ./" + base
                + "\n    " + "is not determined by " + (pattern ? pattern
                + "\n    " + "created from" : "") + JSON.stringify(Object.keys(ignoreMap))
                + "\n    "
                + "\n    " + "please update /.sdkconfig.js file by adding public status for files above"
                + "\n    " + "do not forget .js file extension!"
                + "\n    " + "to retry use " + magenta + "'./scripts/sdk.sh check'" + noColor
                );
        }
    }

    addPaths("", ignoreMap, root);
    return Object.keys(x);
}

function rewritePackageJson(commit, baseTree, state, cb) {
    var options = { state: state, commit: commit };
    async.series([
        function(next) {
            gitCatFile(commit + ":package.json", function(e, r) {
                options.value = r;
                next();
            });
        },
        function(next) {
            if (!baseTree) return next();
            gitCatFile(baseTree + ":package.json", function(e, r) {
                options.oldValue = r;
                next();
            });
        },
        function(next) {
            var newValue = transformPackageJson(options);
            createBlob(newValue, function(e, r) {
                state.fastImport.stdin.write("M 100644 " + r + " package.json\n");
                next();
            });
        },
    ], cb);
}

function transformPackageJson(options) {
    try {
        var json = JSON.parse(options.value);
    } catch (e) {
        return options.oldValue || "";
    }
    json.version = "3.1.5000";
    var sdk = json.sdk || {};
    function copyDeps(sdkDeps, allDeps) {
        if (!sdkDeps) return;
        var deps = {};
        var keys = Array.isArray(sdkDeps) ? sdkDeps : Object.keys(sdkDeps);
        keys.forEach(function(n) {
            deps[n] = sdkDeps.hasOwnProperty(n) && sdkDeps[n] || allDeps[n];
        });
        return deps;
    }

    json.dependencies = copyDeps(sdk.dependencies || {}, json.dependencies);
    json.optionalDependencies = copyDeps(sdk.optionalDependencies, json.optionalDependencies);
    json.devDependencies = copyDeps(sdk.devDependencies, json.devDependencies);
    json.bundledDependencies = sdk.bundledDependencies;

    sdkConfig.NODE_MODULES.forEach(function(n) {
        json.dependencies[n] = undefined;
    });
    json.sdk = undefined;
    json.scripts = sdk.scripts;
    json.repository.url = json.repository && json.repository.url.replace("newclient", "core");

    json.c9plugins = undefined;

    return JSON.stringify(json, null, 4) + "\n";
}

function applySdkConfigRules(tree, next, state, config) {
    state.fastImport.startTmpCommit(null, tree);
    git(["ls-tree", "--name-only", "-r", tree], function(e, r) {
        // console.log(r)
        var keys = getPrivateFileList(r, (config || sdkConfig).privatFileMap);
        if (!keys.length)
            return next();
        keys.forEach(function(path) {
            state.fastImport.stdin.write("D \"" + path.replace(/\/$/, "") + "\"\n");
        });
        next();
    });
}

function createPublicTree(privateTree, baseTree, cb, state) {
    if (!state.sdkConfigmap)
        state.sdkConfigmap = {};
    async.series([
        function(next) {
            if (state.sdkConfigmap[privateTree])
                return next();
            gitCatFile(privateTree + ":.sdkconfig.js", function(e, result, header) {
                if (state.sdkConfigmap[header]) {
                    state.sdkConfigmap[privateTree] = state.sdkConfigmap[header];
                    return next();
                }
                var config = sdkConfig;
                if (result) try {
                    config = evaluate(result, "sdkconfig");
                } catch (e) {
                    console.error(e);
                }

                state.sdkConfigmap[privateTree] =
                state.sdkConfigmap[header] = config;
                next();
            });
        },
        function(next) {
            applySdkConfigRules(privateTree, next, state, state.sdkConfigmap[privateTree]);
        },
        function(next) {
            rewritePackageJson(privateTree, baseTree, state, next);
        },
        function(next) {
            state.fastImport.write("ls \"\"\n", next);
        }
    ], cb);
}

// node-style eval
var vm = require("vm");
function evaluate(code, name) {
    var exports = {};
    var module = { exports: exports };
    vm.runInNewContext(code, {
        require: require,
        exports: exports,
        module: module,
        console: console,
        global: global,
        process: process,
        Buffer: Buffer,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval
    }, name || "dynamic-" + Date.now().toString(36), true);
    return module.exports;
}

exports.revList = revList;
if (module.parent)
    return;

/*** parse options and run the script ***/
var prefix = ("subtree").replace(/^\/|\/$/g, "");
var fullPrefix = prefix.indexOf("refs") == 0 ? prefix : "refs/heads/" + prefix;


function filterBranch(branch) {
    var excludes = fs.readFileSync(__dirname + "/0lf-exclude.txt", "utf8").split("\n");
    excludes = excludes.map(function(a) {
        return a.trim().replace(/^#.*/, "").replace(/\/$/, "");
    }).filter(Boolean);

    var commitActionsTxt = "";
    try {
        commitActionsTxt = fs.readFileSync(__dirname + "/0lf-commitActions.txt", "utf8");
    } catch (e) {}
    var commitActions = {};
    commitActionsTxt.split("\n").forEach(function(a) {
        a = a.trim().split(/\s+/);
        commitActions[a[0]] = a[1];
    });
    console.log(commitActions);
    var t = Date.now()

    git(["rev-list", "--full-history", "--topo-order", branch], function(err, allCommits) {
        assert(!err);
        allCommits = allCommits.split("\n");
        console.log(allCommits.length);

        var fastImport = startFastImport();
        var mark = 0;
        allCommits = allCommits.reverse(); //.slice(0, 2);
        var oldToNew = {};

        forEachSeries(allCommits, function(oldSha, next) {
            mark++;
            gitCatFile(oldSha, function(err, commitContents) {
                assert(!err);
                if (mark % 1000 == 0) console.log(mark, "/", allCommits.length, oldSha, (t - Date.now()) / 1000);
                var r = commitContents.split("\n");
                var tree = r[0].substr(5);
                var parents = [];
                var oldParents = [];
                var commit = oldToNew[oldSha] = {
                    sha: ":" + mark,
                    tree: "",
                    oldSha: oldSha,
                };
                for (var i = 1; i < r.length; i++) {
                    if (r[i][0] != "p") break;
                    var p = r[i].substr(7);
                    if (commitActions[p] == "ignore" || oldToNew[p] && !oldToNew[p].ignore) {
                        parents.push(oldToNew[p].sha);
                        oldParents.push(p);
                    }
                }
                var author = r[i++];
                var committer = r[i++];
                var gpgsig = r[i++];

                if (gpgsig) {
                    while (r[i]) i++;
                }

                var message = r.slice(i).join("\n");

                var parentCommit = oldToNew[oldParents[0]];

                // ignore git subtree root commits
                if (!parents.length && /^Squashed/.test(message) && /^git-subtree-dir:/m.test(message))
                    commit.ignore = true;

                // forward merge consecutive version bumps
                if (isVersionBump(message) || commitActions[oldSha] == "squash") {
                    // console.log("merging", commit)
                    commit.isReplaceable = true;
                    commit.refs = [oldSha];
                    commit.parents = parents;
                    commit.oldParents = oldParents;
                }

                if (parentCommit && parentCommit.isReplaceable && parentCommit.refs && commit.refs) {
                    if (parents.length == 1) {
                        parents = commit.parents = parentCommit.parents;
                        oldParents = commit.oldParents = parentCommit.oldParents;
                        parentCommit.refs.forEach(function(x) {
                            oldToNew[x] = commit;
                        });
                        parentCommit = oldToNew[oldParents[0]];
                    }
                }

                // start commit and apply excludes rules
                fastImport.startCommit(mark, message, author, committer, parents);
                if (rootCommit)
                    fastImport.write("M 040000 " + rootCommit + " \n");

                fastImport.write("M 040000 " + tree + (rootPath ? ` "${rootPath}"` : " ") + "\n");
                excludes.forEach(function(path) {
                    fastImport.stdin.write("D \"" + (rootPath ? `${rootPath}/${path}` : path) + "\"\n");
                });

                // read the tree of the new commit
                fastImport.write("ls \"\"\n", function(e, r) {
                    assert(!e);
                    fastImport.write("\n");
                    commit.tree = r;
                    if (parents[0]) {
                        var isSameTree = parentCommit.tree == commit.tree;
                        if (isSameTree) {
                            oldToNew[oldSha] = parentCommit;
                        }
                        if (parentCommit.refs) {
                            if (isSameTree)
                                parentCommit.refs.push(oldSha);
                            else
                                parentCommit.refs = null;
                        }
                    }
                    next();
                    // fastImport.write("get-mark :" + mark + "\n", function(e, c) {
                    // });
                });
            });
        }, function(e, r) {
            fastImport.write("reset refs/heads/rebased\nfrom :" + mark + "\n\n");
            if (gitCatFile.batchReader)
                gitCatFile.batchReader.end();
            console.log("-------------- done --------------");
            fastImport.end();
        });
    });

    function isVersionBump(message) {
        return /^(c9-version-bump Update version to|c9-auto-bump) [\d.]+/.test(message);
    }
}


function listLargeFiles() {
    function getCachedCommandOutput(cmd, filename, cb) {
        var gitCalled = false;
        getFromDisk();
        function getFromDisk() {
            fs.readFile(filename, "utf8", function(e, r) {
                if (e && !gitCalled) return getFromGit();
                cb(e, r);
            });
        }
        function getFromGit() {
            console.log(cmd);
            gitCalled = true;
            execFile("bash", ["-c", cmd + ">" + filename], { encoding: "utf8" }, function(e, r) {
                console.log(cmd, "done");
                getFromDisk();
            });
        }
    }

    function getVerifyPack(cb) {
        getCachedCommandOutput("git gc && git verify-pack -v .git/objects/pack/*.idx", __dirname + "/0lf-verify-pack", cb);
    }

    function getAllObjects(cb) {
        getCachedCommandOutput("git rev-list --objects --all", __dirname + "/0lf-rev-list", cb);
    }
    getVerifyPack(function(e, r) {
        var f = r.split("\n");
        console.log(f.length);

        // SHA-1 type size size-in-packfile offset-in-packfile

        var h = f.map(function(x) {
            var x1 = x.split(/\s+/);
            if (x1[0].length != 40) return;
            return {
                sha: x1[0],
                type: x1[1],
                size: parseInt(x1[2], 10),
                packedSize: parseInt(x1[3], 10),
                x: x1,
            };
        }).filter(Boolean).sort(function(a, b) {
            return b.size - a.size;
        });
        getAllObjects(function(e, r) {
            var map = {};
            var extraPaths = {};
            r.split("\n").forEach(function(x) {
                var sha = x.slice(0, 40);
                var path = x.substr(41);
                if (map[sha]) {
                    extraPaths[sha] == extraPaths[sha] || [];
                    extraPaths[sha].push(path);
                }
                else {
                    map[sha] = path;
                }
            });

            var byPath = Object.create(null);
            h.forEach(function(x) {
                x.path = map[x.sha];
                if (!byPath[x.path]) {
                    byPath[x.path] = {
                        size: x.size,
                        packedSize: x.packedSize,
                        path: x.path,
                        min: x.size,
                        max: x.size,
                        sha: x.sha,
                    };
                } else {
                    byPath[x.path].size += x.size;
                    byPath[x.path].packedSize += x.packedSize;
                    byPath[x.path].min = Math.min(x.size, byPath[x.path].min);
                    byPath[x.path].max = Math.max(x.size, byPath[x.path].max);
                }
            });

            var mergedList = Object.keys(byPath).map(function(p) {
                return byPath[p];
            }).sort(function(a, b) {
                return b.size - a.size;
            });

            var data = mergedList.map(function(x) {
                return [
                    x.path, x.size, x.packedSize, x.min, x.max, x.sha, extraPaths[x.sha] || ""
                ].map(function(a) {
                    if (typeof a == "number") return a / 1024;
                    return a;
                }).join("\t");
            }).join("\n");

            fs.writeFileSync(__dirname + "/0lf-list.tsv", data, "utf8");
            filter();
        });
    });
    function filter() {
        if (!fs.existsSync(__dirname + "/0lf-exclude.txt"))
            fs.writeFileSync(__dirname + "/0lf-exclude.txt", "# add exclude rules here", "utf8");
        var excludes = fs.readFileSync(__dirname + "/0lf-exclude.txt", "utf8").split("\n");
        excludes = excludes.map(function(a) {
            return a.trim().replace(/^#.*/, "");
        }).filter(Boolean);

        var data = fs.readFileSync(__dirname + "/0lf-list.tsv", "utf8").split("\n");

        var size = 0;
        var filteredSize = 0;
        data = data.filter(function(x) {
            var rowSize = parseFloat(x.split("\t")[2]);
            size += rowSize;
            for (var i = 0; i < excludes.length; i++) {
                var a = excludes[i];
                if (x.slice(0, a.length) == a) {
                    if (a.slice(-1) == "/" || /^[\/\s]*$/.test(x[a.length]))
                        return false;
                }
            }
            filteredSize += rowSize;
            return true;
        });
        console.log(filteredSize / 1024 + "/" + size / 1024);
        fs.writeFileSync(__dirname + "/0lf-filtered.tsv", data.join("\n"), "utf8");
        fs.writeFileSync(__dirname + "/0lf-filtered-1000.tsv", data.slice(0, 1000).join("\n"), "utf8");

        var nm = {};
        data.forEach(function(l) {
            var m = /^node_modules\/[^\/\s]+\//.exec(l);
            if (m) nm[m[0]] = 1;
        });
        fs.writeFileSync(__dirname + "/0lf-node_modules.tsv", Object.keys(nm).sort().join("\n"), "utf8");
    }

}

var command = process.argv[2];
var branch = process.argv[3];


var rootPath = "src/packages/ide";
var rootCommit = "cab6c7970a34d6f2c81145be743efa1d370817ae";

if (command == "listLargeFiles") {
    listLargeFiles();
}
else if (command == "filterBranch") {
    if (rootCommit) {
        revParse(`${rootCommit}^{tree}`, function(e, r) {
            rootCommit = r
            if (!rootCommit)
                throw new Error("rootCommit is not defined")
            filterBranch(branch);
        });
    }
    else {
        filterBranch(branch);
    }
}
else {
    console.log(`
usage
    add AWSCloud9Core as a remote
        git remote add aws ssh://git.amazon.com/pkg/AWSCloud9Core
        git fetch aws
    run node subrepo.js listLargeFiles
     - check list of all files in 0lf-filtered.tsv
     - edit 0lf-exclude.txt to remove files
    run node subrepo.js filterBranch aws/mainline
`);

}