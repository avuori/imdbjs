var http = require("http"),
    fs = require("fs"),
    urlm = require("url"),
    mpath = require("path"),
    redis = require("redis"),
    redisClient = redis.createClient();

require("./strftime.js");

redisClient.on("error", function (err) {
    console.log("Error: " + err);
});

var rootPath = process.argv[2];
var pendingImdbRequests = 0;

var downloadDates = {};

var getNfos = function (path, callback, mtime) {
    var realpath = mpath.normalize(path);
    var stats = fs.statSync(realpath);
    if (stats.isDirectory()) {
        var entries = fs.readdirSync(path);
        // Sort. Newest movies on top.
        entries.sort(function (a, b) {
            var astat = fs.statSync(mpath.normalize(path + "/" + a));
            var bstat = fs.statSync(mpath.normalize(path + "/" + b));
            if (astat.mtime <= bstat.mtime) {
                return 1;
            } else {
                return -1;
            }
        });
        entries.forEach(function (f) {
            getNfos(path + "/" + f, 
                    callback, 
                    stats.mtime);
        });
    } else if (stats.isFile()) {
        if (realpath.match(/.nfo$/)) {
            callback(realpath, mtime);
        }
    }
};

var parseImdbID = function (file) {
    var contents = fs.readFileSync(file, "utf8");
    var matches = contents.match(/http:\/\/[^\/]*imdb\.com\/title\/([^\/]+)\//);
    if (matches) {
        return matches[1];
    }
    return null;
};

var fetchImdbInfos = function (ids, callback) {
    var imdbReqOpt = {
        host: "www.imdb.com",
        port: 80,
    };
    var infos = {};
    var requestReady = function (id, res) {
        infos[id] = res;
        pendingImdbRequests--;
        if (pendingImdbRequests === 0) {
            callback(infos);
        } else {
//            console.log("Pending requests: " + pendingImdbRequests);
        }
    };
    ids.forEach(function (imdbId) {
        redisClient.get(imdbId, function (err, reply) {
            if (reply) {
                console.log("HIT " + imdbId);
                requestReady(imdbId, reply);
            } else {
                console.log("MISS " + imdbId);
                imdbReqOpt.path = "/title/" + imdbId + "/";
                console.log("Fetch " + imdbReqOpt.path);
                var data = "";
                http.get(imdbReqOpt, function (res) {
                    res.on("data", function (chunk) {
                        data += chunk;
                    });
                    res.on("end", function () {
                        console.log("Got response: " + res.statusCode);
                        console.log("Caching " + imdbId);
                        try {
                            redisClient.set(imdbId, data);
                        } catch (e) {
                            console.log("Unable to update cache");
                        }
                        requestReady(imdbId, data);
                    });
                }).on("error", function (e) {
                    requestReady(imdbId, false);
                });
            }
        });
    });
};

var renderPage = function (infos, mtimes, callback) {
    var render = function (id, element, value) {
        if (element == "title") {
            var d = mtimes[id];
            var dateStr = d.strftime("%d.%m.%Y %H:%M:%S");
            return "<div class='date'>" + dateStr +"</div>"
                    + "<h1><a href='" + "http://imdb.com/title/" + id + "'" + ">" + value + "</a></h1>";
        } else if (element == "description") {
            return "<p>" + value + "</p>";
        } else if (element == "image") {
            return "<img src='/image/" + encodeURIComponent(value) + "' />";
        } else {
            return value;
        }
    };
    // genre
    // rating
    // storyline
    // link,
    // runtime
    var page = "";
    for (id in infos) {
        if (!infos[id]) {
            console.log("No info for " + id);
            continue;
        }
        page += "<div class='movie'>";
        var regex = {
            title: /<meta property='og:title' content='([^']+)' \/>/,
            description: /<meta name="description" content="([^"]+)" \/>/,
            image: /<meta property='og:image' content='(http[^']+)'>/
        };
        for (re in regex) {
            var m = infos[id].match(regex[re]);
            if (m) {
                //console.log(re + ": " + m[1]);
                page += render(id, re, m[1]);
            }
        }
        page += "</div>";
    }
    callback(page);
};

http.createServer(function (request, response) {
    if (request.url.indexOf("/image/") === 0) {
        // Serve images
        var url = decodeURIComponent(request.url.substring(7));
//        console.log("REQUEST: " + url);
        var data = [];
        var redisKey = "image." + url;
 //       redisClient.del(redisKey);
        redisClient.get(redisKey, function (err, reply) {
            if (false && reply) {
                console.log("HIT " + url);
                        response.writeHead(200, 
                            {"Content-Type": "image/jpeg",
                             "Content-Length": reply.length});
                response.write(reply, "binary");
                response.end();
            } else {
                console.log("MISS " + url);
                var parsedUrl = urlm.parse(url);
                var opt = {
                    host: parsedUrl.hostname,
                    port: parsedUrl.port || 80,
                    path: parsedUrl.pathname                    
                };
                http.get(opt, function (res) {
                    res.on("data", function (chunk) {
                        data.push(chunk);
                    });
                    res.on("end", function () {
                        try {
                            redisClient.set(redisKey, data);
                        } catch (e) {
                            console.log("Unable to update cache.");
                        }
                        var length = 0;
                        data.forEach(function (chunk) {
                            length += chunk.length;
                        });
                        response.writeHead(200, 
                            {"Content-Type": "image/jpeg",
                             "Content-Length": length});
                        data.forEach(function (chunk) { 
                            response.write(chunk, "binary");
                        });
                        response.end();
                    });
                }).on("error", function (e) {
                    response.end();
                });
            }
        });
    } else {
        // Serve index
        response.writeHead(200, {"Content-Type": "text/html"});
        var ids = [];
        var mtimes = {};
        getNfos(rootPath, function (path, mtime) {
            var imdb = parseImdbID(path);
            if (imdb) {
                ids.push(imdb);
                mtimes[imdb] = mtime;
                pendingImdbRequests++;
            }
        }, null);
        fetchImdbInfos(ids, function (infos) {
            response.write("<html><head><style>"
                        +"body { font-family: sans-serif; }"
                        +"div.movie { margin-bottom: 20px; }"
                        +"h1 { margin: 0; }"
                        +".date { background-color: yellow; }"
                        + "p { margin: 0; }"
                        + "</style></head><body>");
            renderPage(infos, mtimes, function (page) {
                response.write(page, "utf8");
                response.end("</body></html>", "utf8");
            });
        });
    }
}).listen(8124);
console.log("Server running at http://127.0.0.1:8124/");

