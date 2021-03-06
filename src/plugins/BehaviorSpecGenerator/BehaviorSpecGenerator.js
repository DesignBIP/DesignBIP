/*globals define*/
/*jshint node:true, browser:true*/

define([
    'plugin/PluginConfig',
    'text!./metadata.json',
    'plugin/PluginBase',
    'q',
    'common/util/ejs',
    'bipsrc/util/utils',
    'bipsrc/templates/ejsCache',
    'bipsrc/parsers/javaExtra',
    'bipsrc/bower_components/pegjs/peg-0.10.0'
], function (PluginConfig,
             pluginMetadata,
             PluginBase,
             Q,
             ejs,
             utils,
             ejsCache,
             javaParser,
             peg) {
    'use strict';

    pluginMetadata = JSON.parse(pluginMetadata);

    /**
     * Initializes a new instance of ComponentTypeGenerator.
     * @class
     * @augments {PluginBase}
     * @classdesc This class represents the plugin ComponentTypeGenerator.
     * @constructor
     */
    var BehaviorSpecGenerator = function () {
        // Call base class' constructor.
        PluginBase.call(this);
        this.pluginMetadata = pluginMetadata;
    };

    /**
     * Metadata associated with the plugin. Contains id, name, version, description, icon, configStructue etc.
     * This is also available at the instance at this.pluginMetadata.
     * @type {object}
     */
    BehaviorSpecGenerator.metadata = pluginMetadata;

    // Prototypical inheritance from PluginBase.
    BehaviorSpecGenerator.prototype = Object.create(PluginBase.prototype);
    BehaviorSpecGenerator.prototype.constructor = BehaviorSpecGenerator;

    /**
     * Main function for the plugin to execute. This will perform the execution.
     * Notes:
     * - Always log with the provided logger.[error,warning,info,debug].
     * - Do NOT put any user interaction logic UI, etc. inside this method.
     * - callback always has to be called even if error happened.
     *
     * @param {function(string, plugin.PluginResult)} callback - the result callback
     */
    BehaviorSpecGenerator.prototype.main = function (callback) {
        // Use self to access core, project, result, logger etc from PluginBase.
        // These are all instantiated at this point
        var self = this,
            nodes,
            artifact;

        self.loadNodeMap(self.activeNode)
            .then(function (nodes_) {
                nodes = nodes_;

                return BehaviorSpecGenerator.getGeneratedFiles(self, nodes, self.activeNode);
            })
            .then(function (result) {
                if (result.violations.length > 0) {
                    result.violations.forEach(function (violation) {
                        self.createMessage(violation.node, violation.message, 'error');
                    });

                    throw new Error('Model has ' + result.violations.length + ' violation(s). ' +
                        'See messages for details.');
                }

                artifact = self.blobClient.createArtifact('BehaviorSpecifications');
                return artifact.addFiles(result.files);
            })
            .then(function (fileHashes) {
                fileHashes.forEach(function (fileHash) {
                    self.result.addArtifact(fileHash);
                });

                return artifact.save();
            })
            .then(function (artifactHash) {
                self.result.addArtifact(artifactHash);
                self.result.setSuccess(true);
                callback(null, self.result);
            })
            .catch(function (err) {
                self.logger.error(err.stack);
                // Result success is false at invocation.
                callback(err, self.result);
            });

    };

    /**
     *
     * @param {PluginBase} self - An initialized and configured plugin.
     * @param {Object<string, Object>} nodes - all nodes loaded from the projectNode.
     * @param {object} activeNode - the projectNode.
     *
     * @returns {Promise} resolves with {files: Object<string, string>, violations: Objects[]}
     */
    BehaviorSpecGenerator.getGeneratedFiles = function (self, nodes, activeNode, callback) {
        var componentTypePaths = BehaviorSpecGenerator.prototype.getComponentTypePaths.call(self, nodes),
            violations = BehaviorSpecGenerator.prototype.getViolations.call(self, componentTypePaths, nodes),
            fileNames = [],
            promises = [],
            fileName,
            type;

        self.logger.debug('number of components', componentTypePaths.length);

        for (type of componentTypePaths) {
            fileName = self.core.getAttribute(nodes[type], 'name') + '.java';
            fileNames.push(fileName);
            self.logger.debug('filename ' + fileName);
            promises.push(BehaviorSpecGenerator.prototype.getComponentTypeFile.call(self, nodes[type], violations));
        }

        return Q.all(promises)
            .then(function (result) {
                var i,
                    files = {};

                for (i = 0; i < fileNames.length; i += 1) {
                    files[fileNames[i]] = result[i];
                }

                return {
                    files: files,
                    violations: violations
                };
            })
            .nodeify(callback);
    };

    BehaviorSpecGenerator.prototype.getGuardExpression = function (componentModel) {
        var guardNames = [],
            i,
            guardExpressionParser;

        for (i = 0; i < componentModel.guards.length; i += 1) {
            guardNames.push(componentModel.guards[i].name);
        }
        if (guardNames.length > 0) {
            guardExpressionParser = peg.generate(
                ejs.render(ejsCache.guardExpression, {guardNames: guardNames})
            );
        }
        return guardExpressionParser;
    };

    BehaviorSpecGenerator.prototype.getComponentTypePaths = function (nodes) {
        var self = this,
            path,
            node,
            componentTypes = [];

        for (path in nodes) {
            node = nodes[path];
            //TODO: Update for hierarchical components
            if (self.isMetaTypeOf(node, self.META.ComponentType) && (!self.isMetaTypeOf(self.core.getParent(node), self.META.ArchitectureStyle)) && (!self.isMetaTypeOf(self.core.getParent(node), self.META.ComponentTypesLibrary))) {
                componentTypes.push(path);
            }
        }

        return componentTypes;
    };

    BehaviorSpecGenerator.prototype.getComponentTypeFile = function (componentTypeNode, violations, callback) {
        var self = this,
            fileContent,
            guardExpressionParser,
            i;

        return utils.getModelOfComponentType(self.core, componentTypeNode)
            .then(function (componentModel) {
                fileContent = ejs.render(ejsCache.componentType.complete, componentModel);
                var parseResult = javaParser.checkWholeFile(fileContent);
                if (parseResult) {
                    self.logger.debug(parseResult.line);
                    self.logger.debug(parseResult.message);
                    parseResult.node = componentTypeNode;
                    violations.push(parseResult);
                }

                guardExpressionParser = BehaviorSpecGenerator.prototype.getGuardExpression.call(self, componentModel);
                for (i = 0; i < componentModel.transitions.length; i += 1) {
                    if (componentModel.transitions[i].guard.length > 0) {
                        try {
                            parseResult = guardExpressionParser.parse(componentModel.transitions[i].guard);
                        } catch (e) {
                            violations.push({
                                message: 'Guard expression [' + componentModel.transitions[i].guard + '] is not a logical expression that has only defined guard names as symbols. Please update. The allowed symbols of logical operators are: & for conjunnction, | for disjunction and ! for negation.',
                                node: componentTypeNode
                            });
                        }
                    }
                }

                return fileContent;
            })
            .nodeify(callback);
    };

    BehaviorSpecGenerator.prototype.getViolations = function (componentTypes, nodes) {
        var componentTypeNames = {},
            name, type, node,
            child, childPath, childName,
            self = this,
            noInitialState,
            nameAndViolations = {
                violations: [],
                totalStateNames: {},
                transitionNames: {},
                guardNames: {}
            };

        for (type of componentTypes) {
            nameAndViolations.guardNames = {};
            nameAndViolations.totalStateNames = {};
            nameAndViolations.transitionNames = {};
            noInitialState = true;
            node = nodes[type];
            name = self.core.getAttribute(node, 'name');
            if (componentTypeNames.hasOwnProperty(name)) {
                nameAndViolations.violations.push({
                    node: node,
                    message: 'Name [' + name + '] of component type [' + type + '] is not unique. Please rename. ' +
                    'Component types must have unique names. '
                });
            }
            componentTypeNames[name] = self.core.getPath(node);
            for (childPath of self.core.getChildrenPaths(node)) {
                child = nodes[childPath];
                childName = self.core.getAttribute(child, 'name');
                if ((self.isMetaTypeOf(child, self.META.InitialState))) {
                    noInitialState = false;
                }
                nameAndViolations = BehaviorSpecGenerator.prototype.hasChildViolations.call(self, child, childName,
                    nameAndViolations);
            }
            if (noInitialState) {
                nameAndViolations.violations.push({
                    node: node,
                    message: 'Component type [' + name + '] does not have an initial state. ' +
                    'Please define an initial state.'
                });
            }
        }

        return nameAndViolations.violations;
    };

    BehaviorSpecGenerator.prototype.hasChildViolations = function (child, childName, nameAndViolations) {
        var self = this;

        if ((self.isMetaTypeOf(child, self.META.State)) || (self.isMetaTypeOf(child, self.META.InitialState))) {
            if (nameAndViolations.totalStateNames.hasOwnProperty(childName)) {
                nameAndViolations.violations.push({
                    node: child,
                    message: 'Name [' + childName + '] of state [' + child + '] is not unique. ' +
                    'Please rename. States that belong to the same component type must have unique names.'
                });
            }
            nameAndViolations.totalStateNames[childName] = self.core.getPath(child);
        }
        if (self.isMetaTypeOf(child, self.META.EnforceableTransition) ||
            self.isMetaTypeOf(child, self.META.SpontaneousTransition) ||
            self.isMetaTypeOf(child, self.META.InternalTransition)) {

            if (this.core.getPointerPath(child, 'dst') === null) {
                nameAndViolations.violations.push({
                    node: child,
                    message: 'Transition [' + childName + '] with no destination encountered. ' +
                    'Please connect or remove it.'
                });
            }
            if (this.core.getPointerPath(child, 'src') === null) {
                nameAndViolations.violations.push({
                    node: child,
                    message: 'Transition [' + childName + '] with no source encountered. Please connect or remove it.'
                });
            }
            if (this.core.getAttribute(child, 'transitionMethod') === '') {
                nameAndViolations.violations.push({
                    node: child,
                    message: 'Attribute transitionMethod of transition [' + childName + '] is not defined. ' +
                    'Please define transitionMethod.'
                });
            }
        }
        if (self.isMetaTypeOf(child, self.META.EnforceableTransition) ||
            self.isMetaTypeOf(child, self.META.SpontaneousTransition)) {

            if (nameAndViolations.transitionNames.hasOwnProperty(childName)) {
                nameAndViolations.violations.push({
                    node: child,
                    message: 'Name [' + childName + '] of transition    is not unique. ' +
                    'Please rename. Enforceable and spontaneous transitions of the same component ' +
                    'type must have unique names.'
                });
            }
            nameAndViolations.transitionNames[childName] = self.core.getPath(child);
        }
        if (self.isMetaTypeOf(child, self.META.Guard)) {
            if (nameAndViolations.guardNames.hasOwnProperty(childName)) {
                nameAndViolations.violations.push({
                    node: child,
                    message: 'Name [' + childName + '] of guard is not unique. Please rename. ' +
                    'Guards of the same component type must have unique names.'
                });
            }
            nameAndViolations.guardNames[childName] = self.core.getPath(child);

            if (self.core.getAttribute(child, 'guardMethod') === '') {
                nameAndViolations.violations.push({
                    node: child,
                    message: 'Attribute guardMethod of transition [' + childName + '] is not defined. ' +
                    'Please define guardMethod.'
                });
            }
        }
        return nameAndViolations;
    };

    return BehaviorSpecGenerator;
});
