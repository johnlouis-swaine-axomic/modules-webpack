/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
var buildDeps = require("./buildDeps");
var path = require("path");
var writeChunk = require("./writeChunk");
var fs = require("fs");

var HASH_REGEXP = /\[hash\]/i;

/*
	webpack(context, moduleName, options, callback);
	webpack(context, moduleName, callback);
	webpack(absoluteModulePath, options, callback);
	webpack(absoluteModulePath, callback);

	callback: function(err, source / stats)
	  source if options.output is not set
	  else stats json

	options:
	- outputJsonpFunction
	   JSONP function used to load chunks
	- scriptSrcPrefix
	   Path from where chunks are loaded
	- outputDirectory
	   write files to this directory (absolute path)
	- output
	   write first chunk to this file
	- outputPostfix
	   write chunks to files named chunkId plus outputPostfix
	- libary
	   exports of input file are stored in this variable
	- minimize
	   minimize outputs with uglify-js
	- includeFilenames
	   add absolute filenames of input files as comments
	- resolve.alias (object)
	   replace a module. ex {"old-module": "new-module"}
	- resolve.extensions (object)
	   possible extensions for files
	- resolve.paths (array)
	   search paths
	- resolve.loaders (array)
	   extension to loader mappings
	   {test: /\.extension$/, loader: "myloader"}
	   loads files that matches the RegExp to the loader if no other loader set
	- parse.overwrites (object)
	   free module varables which are replaced with a module
	   ex. { "$": "jquery" }
*/
module.exports = function(context, moduleName, options, callback) {
	if(typeof moduleName === "object") {
		callback = options;
		options = moduleName;
		moduleName = "./" + path.basename(context);
		context = path.dirname(context);
	}
	if(typeof moduleName === "function") {
		callback = moduleName;
		options = {};
		moduleName = "./" + path.basename(context);
		context = path.dirname(context);
	}
	if(!callback) {
		callback = options;
		options = {};
	}
	if(!options.events) options.events = new (require("events").EventEmitter)();
	if(options.watch) {
		var fs = require("fs");
		var watchers = [];
		var isRunning = true;
		var runAgain = false;
		function startAgain() {
			watchers.forEach(function(watcher) {
				watcher.close();
			});
			watchers.length = 0;
			isRunning = true;
			setTimeout(function() {
				runAgain = false;
				webpack(context, moduleName, options, callback);
			}, 200);
		}
		function change() {
			if(isRunning)
				runAgain = true;
			else
				startAgain()
		}
		options.events.on("module", function(module, filename) {
			if(!filename) return;
			var w = fs.watch(filename, function() {
				change();
			});
		});
		options.events.on("context", function(module, dirname) {
			if(!dirname) return;
			fs.watch(dirname, function() {
				change();
			});
		});
		options.events.on("bundle", function(stats) {
			isRunning = false;
			if(runAgain)
				startAgain();
		});
	}
	return webpack(context, moduleName, options, callback);
}
function webpack(context, moduleName, options, finalCallback) {
	options.parse = options.parse || {};
	options.parse.overwrites = options.parse.overwrites || {};
	options.parse.overwrites.process = options.parse.overwrites.process || ("__webpack_process");
	options.parse.overwrites.module = options.parse.overwrites.module || ("__webpack_module+(module)");
	options.parse.overwrites.console = options.parse.overwrites.console || ("__webpack_console");
	options.parse.overwrites.global = options.parse.overwrites.global || ("__webpack_global");
	options.parse.overwrites.Buffer = options.parse.overwrites.Buffer || ("buffer+.Buffer");
	options.parse.overwrites["__dirname"] = options.parse.overwrites["__dirname"] || ("__webpack_dirname");
	options.parse.overwrites["__filename"] = options.parse.overwrites["__filename"] || ("__webpack_filename");
	options.resolve = options.resolve || {};
	options.resolve.paths = options.resolve.paths || [];
	options.resolve.paths.push(path.join(path.dirname(__dirname), "buildin"));
	options.resolve.paths.push(path.join(path.dirname(__dirname), "buildin", "web_modules"));
	options.resolve.paths.push(path.join(path.dirname(__dirname), "buildin", "node_modules"));
	options.resolve.paths.push(path.join(path.dirname(__dirname), "node_modules"));
	options.resolve.alias = options.resolve.alias || {};
	options.resolve.loaders = options.resolve.loaders || [];
	options.resolve.loaders.push({test: /\.coffee$/, loader: "coffee"});
	options.resolve.loaders.push({test: /\.json$/, loader: "json"});
	options.resolve.loaders.push({test: /\.jade$/, loader: "jade"});
	options.resolve.loaders.push({test: /\.css$/, loader: "style!css"});
	options.resolve.loaders.push({test: /\.less$/, loader: "style!css!val!less"});
	
	if(options.output) {
		if(!options.outputDirectory) {
			options.outputDirectory = path.dirname(options.output);
			options.output = path.basename(options.output);
		}
		if(!options.outputPostfix) {
			options.outputPostfix = "." + options.output;
		}
	}
	
	var fileWrites = [];
	options.loader = options.loader || {};
	options.loader.emitFile = options.loader.emitFile || function(filename, content) {
		fileWrites.push([path.join(options.outputDirectory, filename), content]);
	}
	
	options.events.emit("task", "create ouput directory");
	options.events.emit("task", "prepare chunks");
	options.events.emit("task", "statistics");
	buildDeps(context, moduleName, options, function(err, depTree) {
		function callback(err, result) {
			options.events.emit("task-end", "statistics");
			finalCallback(err, result);
		}
		if(err) {
			callback(err);
			return;
		}
		var buffer = [];
		if(options.output) {
			if(!options.outputJsonpFunction)
				options.outputJsonpFunction = "webpackJsonp" + (options.libary  || "");
			options.scriptSrcPrefix = options.scriptSrcPrefix || "";
			var fileSizeMap = {};
			var fileModulesMap = {};
			var chunksCount = 0;
			var chunkIds = Object.keys(depTree.chunks);
			chunkIds.sort(function(a,b) {
				return parseInt(b, 10) - parseInt(a, 10);
			});
			var template = getTemplate(options, {chunks: chunkIds.length > 1});
			var hash;
			try {
				hash = new (require("crypto").Hash)("md5");
				hash.update(JSON.stringify(options.libary || ""));
				hash.update(JSON.stringify(options.outputPostfix));
				hash.update(JSON.stringify(options.outputJsonpFunction));
				hash.update(JSON.stringify(options.scriptSrcPrefix));
				hash.update(template);
				hash.update("1");
			} catch(e) {
				callback(e);
				return;
				hash = null;
			}
			chunkIds.forEach(function(chunkId) {
				var chunk = depTree.chunks[chunkId];
				if(chunk.empty) return;
				if(chunk.equals !== undefined) return;
				chunksCount++;
				var filename = path.join(options.outputDirectory,
					chunk.id === 0 ? options.output : chunk.id + options.outputPostfix);
				var content = writeChunk(depTree, chunk, options);
				if(hash) hash.update(content);
				buffer = [];
				if(chunk.id === 0) {
					if(hash)
						hash = hash.digest("hex");
					else
						hash = "";
					if(options.libary) {
						buffer.push("/******/var ");
						buffer.push(options.libary);
						buffer.push("=\n");
					}
					if(chunkIds.length > 1) {
						buffer.push(template);
						buffer.push("/******/({a:");
						buffer.push(JSON.stringify(options.outputPostfix.replace(HASH_REGEXP, hash)));
						buffer.push(",b:");
						buffer.push(JSON.stringify(options.outputJsonpFunction));
						buffer.push(",c:");
						buffer.push(JSON.stringify(options.scriptSrcPrefix.replace(HASH_REGEXP, hash)));
						buffer.push(",\n");
					} else {
						buffer.push(template);
						buffer.push("/******/({\n");
					}
				} else {
					buffer.push("/******/");
					buffer.push(options.outputJsonpFunction);
					buffer.push("(");
					buffer.push(chunk.id);
					buffer.push(", {\n");
				}
				buffer.push(content);
				buffer.push("/******/})");
				buffer = buffer.join("");
				try {
					if(options.minimize) buffer = uglify(buffer, filename);
				} catch(e) {
					callback(e);
					return;
				}
				fileWrites.push([filename, buffer]);
				var modulesArray = [];
				for(var moduleId in chunk.modules) {
					var modu = depTree.modules[moduleId];
					if(chunk.modules[moduleId] === "include") {
						modulesArray.push({
							id: modu.realId,
							size: modu.size,
							filename: modu.filename,
							dirname: modu.dirname,
							reasons: modu.reasons});
					}
				}
				modulesArray.sort(function(a, b) {
					return a.id - b.id;
				});
				fileModulesMap[path.basename(filename)] = modulesArray;
			});
			options.events.emit("task-end", "prepare chunks");
			options.events.emit("start-writing", hash);
			// write files
			var remFiles = fileWrites.length;
			var outDir = options.outputDirectory.replace(HASH_REGEXP, hash);
			function createDir(dir, callback) {
				path.exists(dir, function(exists) {
					if(exists)
						callback();
					else {
						fs.mkdir(dir, function(err) {
							if(err) {
								var parentDir = path.join(dir, "..");
								if(parentDir == dir)
									return callback(err);
								createDir(parentDir, function(err) {
									if(err) return callback(err);
									fs.mkdir(dir, function(err) {
										if(err) return callback(err);
										callback();
									});
								});
								return;
							}
							callback();
						});
					}
				});
			}
			createDir(outDir, function(err) {
				options.events.emit("task-end", "create ouput directory");
				if(err) return callback(err);
				writeFiles();
			});
			function writeFiles() {
				fileWrites.forEach(function(writeAction) {
					options.events.emit("task", "write " + writeAction[0]);
					fileSizeMap[path.basename(writeAction[0])] = writeAction[1].length;
					fs.writeFile(writeAction[0].replace(HASH_REGEXP, hash), writeAction[1], "utf-8", function(err) {
						options.events.emit("task-end", "write " + writeAction[0]);
						if(err) throw err;
						remFiles--;
						if(remFiles === 0)
							writingFinished();
					});
				});
			}
			function writingFinished() {
				// Stats
				buffer = {};
				buffer.hash = hash;
				buffer.chunkCount = chunksCount;
				buffer.modulesCount = Object.keys(depTree.modules).length;
				var sum = 0;
				for(var chunkId in depTree.chunks) {
					for(var moduleId in depTree.chunks[chunkId].modules) {
						if(depTree.chunks[chunkId].modules[moduleId] === "include")
							sum++;
					}
				}
				buffer.modulesIncludingDuplicates = sum;
				buffer.modulesPerChunk = Math.round(sum / chunksCount*10)/10;
				sum = 0;
				for(var moduleId in depTree.chunks[0].modules) {
					if(depTree.chunks[0].modules[moduleId] === "include")
						sum++;
				}
				buffer.modulesFirstChunk = sum;
				buffer.fileSizes = fileSizeMap;
				buffer.warnings = depTree.warnings;
				buffer.errors = depTree.errors;
				buffer.fileModules = fileModulesMap;
				options.events.emit("bundle", buffer);
				callback(null, buffer);
			}
		} else {
			if(options.libary) {
				buffer.push("/******/var ");
				buffer.push(options.libary);
				buffer.push("=\n");
			}
			buffer.push(getTemplate(options, {chunks: false}));
			buffer.push("/******/({\n");
			buffer.push(writeChunk(depTree, options));
			buffer.push("/******/})");
			buffer = buffer.join("");
			try {
				if(options.minimize) buffer = uglify(buffer, "output");
				callback(null, buffer);
			} catch(e) {
				callback(e);
			}
		}
	});
	return options.events;
}

function getTemplate(options, templateOptions) {
	if(options.template) {
		if(typeof options.template === "string")
			return require(options.template)(options, templateOptions);
		else
			return options.template(options, templateOptions);
	} else 
		return require("../templates/browser")(options, templateOptions);
}

function uglify(input, filename) {
	var uglify = require("uglify-js");
	try {
		source = uglify.parser.parse(input);
		source = uglify.uglify.ast_mangle(source);
		source = uglify.uglify.ast_squeeze(source);
		source = uglify.uglify.gen_code(source);
	} catch(e) {
		throw new Error(filename + " @ Line " + e.line + ", Col " + e.col + ", " + e.message);
		return input;
	}
	return source;
}