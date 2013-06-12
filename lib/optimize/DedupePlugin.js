/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
var ConcatSource = require("webpack-core/lib/ConcatSource");
var TemplateArgumentDependency = require("../dependencies/TemplateArgumentDependency");

function DedupePlugin() {
}
module.exports = DedupePlugin;

DedupePlugin.prototype.apply = function(compiler) {
	compiler.plugin("compilation", function(compilation) {

		compilation.dependencyTemplates.set(TemplateArgumentDependency, new TemplateArgumentDependency.Template());

		compilation.plugin("after-optimize-modules", function(modules) {
			var modulesByHash = {};
			var allDups = [];
			modules.forEach(function(module, idx) {
				if(!module.getSourceHash || !module.getAllModuleDependencies || !module.createTemplate || !module.getTemplateArguments) return;
				var hash = module.getSourceHash();
				var dupModule = modulesByHash[hash];
				if(dupModule) {
					if(dupModule.duplicates) {
						dupModule.duplicates.push(module);
						module.duplicates = dupModule.duplicates;
					} else {
						allDups.push(module.duplicates = dupModule.duplicates = [dupModule, module]);
					}
				} else {
					modulesByHash[hash] = module;
				}
			});
		});
		compilation.plugin("after-optimize-chunks", function(chunks) {
			var entryChunks = chunks.filter(function(c) { return c.entry; });
			entryChunks.forEach(function(chunk) {
				(function x(dups, roots, visited, chunk) {
					var currentDups = [];
					var currentRoots = [];
					chunk.modules.forEach(function(module) {
						if(module.duplicates) {
							var idx = currentDups.indexOf(module.duplicates);
							if(idx >= 0) {
								module.rootDuplicates = currentRoots[idx];
								module.rootDuplicates.push(module);
								module.rootDuplicates.commonModules = mergeCommonModules(module.rootDuplicates.commonModules, module.getAllModuleDependencies());
							} else {
								idx = dups.indexOf(module.duplicates);
								if(idx < 0) {
									module.rootDuplicates = [module];
									module.rootDuplicates.commonModules = module.getAllModuleDependencies();
									module.rootDuplicates.initialCcommonModulesLength = module.rootDuplicates.commonModules.length;
									dups = dups.concat([module.duplicates]);
									roots = roots.concat([module.rootDuplicates]);
									currentDups = currentDups.concat([module.duplicates]);
									currentRoots = currentRoots.concat([module.rootDuplicates]);
								} else {
									module.rootDuplicates = roots[idx];
									module.rootDuplicates.commonModules = mergeCommonModules(module.rootDuplicates.commonModules, module.getAllModuleDependencies());
								}
							}
						}
					});
					chunk.chunks.forEach(function(chunk) {
						if(visited.indexOf(chunk) < 0)
							x(dups, roots, visited.concat(chunk), chunk);
					})

					currentRoots.forEach(function(roots) {
						var commonModules = roots.commonModules;
						var initialLength = roots.initialCcommonModulesLength;
						if(initialLength !== commonModules.length) {
							var template = roots[0].createTemplate(commonModules);
							roots.template = template;
							chunk.addModule(template);
							template.addChunk(chunk);
							compilation.modules.push(template);
						}
					});
				}([], [], [], chunk));
			});
		});
		function mergeCommonModules(commonModules, newModules) {
			return commonModules.filter(function(module) {
				return newModules.indexOf(module) >= 0;
			});
		}
	});
	compiler.moduleTemplate = new DedupModuleTemplateDecorator(compiler.moduleTemplate);
	compiler.mainTemplate.renderAddModule = function(hash, chunk, varModuleId, varModule) {
		return [
			"var _m = " + varModule + ";",
			"switch(typeof _m) {",
			"case \"number\":",
			this.indent([
				"modules[" + varModuleId + "] = modules[_m];",
				"break;"
			]),
			"case \"object\":",
			this.indent([
				"modules[" + varModuleId + "] = (function(_m) {",
				this.indent([
					"var args = _m.slice(1), fn = modules[_m[0]];",
					"return function (a,b,c) {",
					this.indent([
						"fn.apply(null, [a,b,c].concat(args));"
					]),
					"};"
				]),
				"}(_m));",
				"break;"
			]),
			"default:",
			this.indent("modules[" + varModuleId + "] = _m;"),
			"}"
		]
	};
	var oldRenderModules = compiler.mainTemplate.renderModules;
	compiler.mainTemplate.renderModules = function renderModules(hash, chunk, moduleTemplate, dependencyTemplates) {
		var source = new ConcatSource();
		source.add("(function(modules) {\n");
		source.add(this.indent([
			"for(var i in modules) {",
			this.indent([
				"switch(typeof modules[i]) {",
				"case \"number\":",
				this.indent([
					"modules[i] = modules[modules[i]];",
					"break;"
				]),
				"case \"object\":",
				this.indent([
					"modules[i] = (function(_m) {",
					this.indent([
						"var args = _m.slice(1), fn = modules[_m[0]];",
						"return function (a,b,c) {",
						this.indent([
							"fn.apply(null, [a,b,c].concat(args));"
						]),
						"};"
					]),
					"}(modules[i]));"
				]),
				"}"
			]),
			"}",
			"return modules;"
		]));
		source.add("\n}(");
		source.add(oldRenderModules.call(this, hash, chunk, moduleTemplate, dependencyTemplates));
		source.add("))");
		return source;
	};
};

function DedupModuleTemplateDecorator(template) {
	this.template = template;
}

DedupModuleTemplateDecorator.prototype.render = function(module, dependencyTemplates) {
	if(!module.rootDuplicates) return this.template.render(module, dependencyTemplates);
	if(module.rootDuplicates.template) {
		module.rootDuplicates.template.addReason(module, {
			type: "template",
			request: module.request,
			templateModules: module.rootDuplicates.template.templateModules
		});
		var array = [module.rootDuplicates.template.id].concat(module.getTemplateArguments(module.rootDuplicates.template.templateModules).map(function(module) {
			if(typeof module.id !== "number")
				return "(function webpackMissingModule() { throw new Error(" + JSON.stringify("Cannot find module") + "); }())"
			return module.id;
		}));
		var source = new ConcatSource("[" + array.join(", ") + "]");
		return source;
	} else {
		module.rootDuplicates.sort(function(a, b) {
			return a.id - b.id;
		});
		if(module === module.rootDuplicates[0]) return this.template.render(module, dependencyTemplates);
		var source = new ConcatSource("" + module.rootDuplicates[0].id);
		return source;
	}
};

DedupModuleTemplateDecorator.prototype.updateHash = function(hash) {
	hash.update("DedupModuleTemplateDecorator");
	this.template.updateHash(hash);
};