/*globals define*/
/*jshint node:true, browser:true*/


define([
    'plugin/PluginConfig',
    'text!./metadata.json',
    'plugin/PluginBase',
    'q',
     'plugin/JavaBIPEngine/JavaBIPEngine/ArithmeticExpressionParser',
     'plugin/ArchitectureSpecGenerator/ArchitectureSpecGenerator/ArchitectureSpecGenerator',
     'plugin/BehaviorSpecGenerator/BehaviorSpecGenerator/BehaviorSpecGenerator',
     'common/util/ejs',
     'text!./Templates/caseStudy.ejs',
     'common/util/guid'
], function (
    PluginConfig,
    pluginMetadata,
    PluginBase,
    Q,
    ArithmeticExpressionParser,
    ArchitectureSpecGenerator,
    BehaviorSpecGenerator,
    ejs,
    caseStudyTemplate,
    guid) {
    'use strict';

    pluginMetadata = JSON.parse(pluginMetadata);

    /**
     * Initializes a new instance of JavaBIPEngine.
     * @class
     * @augments {PluginBase}
     * @classdesc This class represents the plugin JavaBIPEngine.
     * @constructor
     */
    var JavaBIPEngine = function () {
        // Call base class' constructor.
        PluginBase.call(this);
        this.pluginMetadata = pluginMetadata;
    };

    /**
     * Metadata associated with the plugin. Contains id, name, version, description, icon, configStructue etc.
     * This is also available at the instance at this.pluginMetadata.
     * @type {object}
     */
    JavaBIPEngine.metadata = pluginMetadata;

    // Prototypical inheritance from PluginBase.
    JavaBIPEngine.prototype = Object.create(PluginBase.prototype);
    JavaBIPEngine.prototype.constructor = JavaBIPEngine;

    /**
     * Main function for the plugin to execute. This will perform the execution.
     * Notes:
     * - Always log with the provided logger.[error,warning,info,debug].
     * - Do NOT put any user interaction logic UI, etc. inside this method.
     * - callback always has to be called even if error happened.
     *
     * @param {function(string, plugin.PluginResult)} callback - the result callback
     */
    JavaBIPEngine.prototype.main = function (callback) {
        // Use self to access core, project, result, logger etc from PluginBase.
        // These are all instantiated at this point.
        var self = this,
            path,
            fs,
            artifact,
            nodes;

        if (typeof window === 'undefined') {
            path = process.cwd();
            fs = require('fs');
            if (!fs.existsSync('projectOutputs')) {
                fs.mkdirSync('projectOutputs');
            }
            path += '/projectOutputs/' + self.core.getAttribute(self.activeNode, 'name') + guid();
            path = path.replace(/\s+/g, '');
        }

        self.loadNodeMap(self.activeNode)
            .then(function (nodes_) {
                var glueObject;
                nodes = nodes_;
                glueObject = ArchitectureSpecGenerator.getGeneratedFile(self, nodes, self.activeNode);
                if (fs && path && glueObject.violations.length === 0) {
                    try {
                        fs.statSync(path);
                    } catch (err) {
                        if (err.code === 'ENOENT') {
                            fs.mkdirSync(path);
                        }
                    }
                    fs.writeFileSync(path + '/' + 'Glue.xml', glueObject.fileContent, 'utf8');
                } else if (glueObject.violations.length > 0) {
                    glueObject.violations.forEach(function (violation) {
                        self.createMessage(violation.node, violation.message, 'error');
                    });
                    throw new Error('Architecture model has ' + glueObject.violations.length +
                          '  violation(s), see messages for details.');
                }
                return BehaviorSpecGenerator.getGeneratedFiles(self, nodes, self.activeNode);
            })
                .then(function (behaviorObject) {
                    var behaviorFiles, file,
                        violations, inconsistencies,
                        fileName, testInfo, pathArrayForFile,
                        compilationOutput, compilationjson,
                        currentConfig = self.getCurrentConfig(),
                        filesToAdd = {},
                        architectureModel = {};

                    if (fs && path && behaviorObject.violations.length === 0) {
                        behaviorFiles = behaviorObject.files;
                        self.logger.debug(behaviorFiles.length);
                        for (file in behaviorFiles) {
                            fs.writeFileSync(path + '/' + file, behaviorFiles[file], 'utf8');
                        }
                    } else if (behaviorObject.violations.length > 0) {
                        behaviorObject.violations.forEach(function (violation) {
                            self.createMessage(violation.node, violation.message, 'error');
                        });
                        throw new Error('Behavior model has ' + behaviorObject.violations.length +
                              '  violation(s), see messages for details.');
                    }
                    violations = self.hasViolations(nodes);
                    if (violations.length > 0) {
                        violations.forEach(function (violation) {
                            self.createMessage(violation.node, violation.message, 'error');
                        });
                        throw new Error('Parameterized model has ' + violations.length + ' violation(s), see messages for details.');
                    }
                    architectureModel = self.getArchitectureModel(nodes);
                    inconsistencies = self.checkConsistency(architectureModel, nodes);
                    self.logger.debug('number of inconsistencies: '+ inconsistencies.length);
                    if (inconsistencies.length === 0) {
                        testInfo = self.generateTestInfo(architectureModel, path);
                        fileName = testInfo.className + '.java';
                        pathArrayForFile = fileName.split('/');
                        filesToAdd[fileName] = ejs.render(caseStudyTemplate, testInfo);
                        if (path && fs) {
                            if (pathArrayForFile.length >= 1) {
                                self.compileAndSimulate(behaviorFiles, filesToAdd[fileName], fileName, path, fs);
                                compilationOutput = fs.readFileSync(path + '/engineOutput.json', 'utf8');
                                compilationjson = JSON.parse(compilationOutput);
                                if(compilationjson.output.length > currentConfig['transitions']) {
                                    compilationjson.output.splice(currentConfig['transitions'], compilationjson.output.length-currentConfig['transitions']);
                               }
                                filesToAdd['engineOutput.json'] = JSON.stringify(compilationjson);
                            }
                        }
                        artifact = self.blobClient.createArtifact('EngineInputAndOutput');
                        if (path && fs) {
                            return Q.all([
                            artifact.addFile(fileName, filesToAdd[fileName]),
                            artifact.addFile('engineOutput.json', filesToAdd['engineOutput.json'])
                          ]);
                        } else {
                            return artifact.addFiles(filesToAdd);
                        }
                    } else {
                        inconsistencies.forEach(function (inconsistency) {
                            self.createMessage(inconsistency.node, inconsistency.message, 'error');
                        });
                        throw new Error('Model has ' + inconsistencies.length + ' inconsistencies, see messages for details.');
                    }
                })
                .then(function (fileHashes) {
                  self.logger.debug(fileHashes);
                     fileHashes.forEach(function (fileHash) {
                         self.result.addArtifact(fileHash);
                     });
                    if (path && fs) {
                      self.core.setAttribute(self.activeNode, 'engineOutput', fileHashes[1]);
                      self.logger.debug('before save', self.currentHash);
                      return self.save('Engine output added to results');
                    }
                })
                .then(function () {
                  self.logger.debug('after save', self.currentHash);
                  //TODO: Better name of tag..
                  return self.project.createTag('Engine' + Date.now(), self.currentHash);
                })
                .then(function () {
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

    JavaBIPEngine.prototype.compileAndSimulate = function (behaviorFiles, fileValue, fileName, path, fs) {
        var file, child, execSync,
           self = this,
           compileCode = '',
           simulateCode = '';

        execSync = require('child_process').execSync;
        try {
            fs.statSync(path);
        } catch (err) {
            if (err.code === 'ENOENT') {
                fs.mkdirSync(path);
            }
        }
        fs.writeFileSync(path + '/' + fileName, fileValue, 'utf8');
        compileCode += '#!/bin/bash '+ '\n\n';
        for (file in behaviorFiles) {
            compileCode += 'javac -cp "' + process.cwd() + '/engineLibraries/*" ' + path + '/' + file + '\n\n';
        }
        compileCode += 'javac -cp "' + path + '/:' + process.cwd() + '/engineLibraries/*" ' + path + '/' + fileName;
        self.logger.debug(compileCode);

        fs.writeFileSync(path + '/compile.sh', compileCode, 'utf8');
        //self.sendNotification('Compilation script has been successfully created.');
        //child = execSync('chmod 775 ' + path + '/compile.sh');
        self.sendNotification('Compiling Java code..');
        try {
            child = execSync('/bin/bash ' + path + '/compile.sh');
        } catch (e) {
            self.logger.error(e.stderr);
            throw e;
        }
        simulateCode = 'java -cp "' + path + '/:' + process.cwd() + '/engineLibraries/*" org.junit.runner.JUnitCore ' + fileName.slice(0, -5);
        self.logger.debug(simulateCode);

        fs.writeFileSync(path + '/simulate.sh', simulateCode, 'utf8');
        self.sendNotification('Compilation successful.');

        //child = execSync('chmod 775 ' + path + '/simulate.sh');
        self.sendNotification('Calling simulate..');
        try {
            child = execSync('/bin/bash ' + path + '/simulate.sh');
        } catch (e) {
            self.logger.error('stderr ' + e.stderr);
            throw e;
        }
        self.sendNotification('Simulation successful.');
    };

    JavaBIPEngine.prototype.getArchitectureModel = function (nodes) {
        var self = this,
        path, node, cardinality, child,
        srcConnectorEnd, dstConnectorEnd, end,
        currentConfig = self.getCurrentConfig(),
        architectureModel = {
            componentTypes: [],
            ports: [],
            subConnectors: [],
            connectorEnds: [],
            connections: [],
            connectors: []
        };
        for (path in nodes) {
            node = nodes[path];
            //TODO: Update for hierarchical models
            if (!self.isMetaTypeOf(self.core.getParent(node), self.META.ArchitectureStyle) && !self.isMetaTypeOf(self.core.getParent(node), self.META.ComponentTypesLibrary)) {
                if (self.isMetaTypeOf(node, self.META.ComponentType)) {
                    cardinality = self.core.getAttribute(node, 'cardinality');
                    architectureModel.componentTypes.push(node);
                    node.name  = self.core.getAttribute(node, 'name');
                    node.path = path;
                    for (child of self.core.getChildrenPaths(node)) {
                        if (self.isMetaTypeOf(nodes[child], self.META.EnforceableTransition)) {
                            architectureModel.ports.push(nodes[child]);
                            if (/^[a-z]$/.test(cardinality)) {
                                node.cardinalityParameter = cardinality;
                                self.logger.debug('cardinalityParameter ' + node.cardinalityParameter);
                                cardinality = currentConfig[cardinality];
                            }
                            self.logger.debug('cardinality: ' + cardinality);
                            nodes[child].cardinality = cardinality;
                        }
                    }
                    node.cardinalityValue = cardinality;
                    self.logger.debug('cardinalityValue ' + node.cardinalityValue);

                } else if (self.isMetaTypeOf(node, self.META.Connector)) {
                    /* If the connector is binary */
                    if (self.getMetaType(nodes[self.core.getPointerPath(node, 'dst')]) !== self.META.Connector) {
                        architectureModel.connectors.push(node);
                        srcConnectorEnd = nodes[self.core.getPointerPath(node, 'src')];
                        dstConnectorEnd = nodes[self.core.getPointerPath(node, 'dst')];
                        srcConnectorEnd.connector = node;
                        dstConnectorEnd.connector = node;
                        node.ends = [srcConnectorEnd, dstConnectorEnd];
                    /* If it is part of an n-ary connector */
                    } else {
                        architectureModel.subConnectors.push(node);
                    }
                } else if (self.isMetaTypeOf(node, self.META.Connection) && self.getMetaType(node) !== node) {
                    architectureModel.connections.push(node);
                    end = nodes[self.core.getPointerPath(node, 'src')];
                    if (self.getMetaType(end) !== self.META.Connector) {
                        architectureModel.connectorEnds.push(end);
                        end.degree = self.core.getAttribute(end, 'degree');
                        end.multiplicity = self.core.getAttribute(end, 'multiplicity');
                    }
                    //TODO: add export ports for hierarchical connector motifs
                }
          }
        }
        return architectureModel;
    };

    JavaBIPEngine.prototype.checkConnectorConsistency = function (architectureModel) {
        var subPart, end, matchingFactor, type, newMatchingFactor,
            inconsistencies = [];

        for (subPart of architectureModel.connectors) {
            matchingFactor = -1;
            for (end of subPart.ends) {
                if (!/^[0-9]+$/.test(end.degree)) {
                    for (type of architectureModel.componentTypes) {
                        if (type.cardinalityParameter !== undefined && end.degree.includes(type.cardinalityParameter)) {
                            end.degree = end.degree.replace(type.cardinalityParameter, type.cardinalityValue);
                        }
                    }
                    //TODO: Change the eval
                    end.degree = eval(end.degree);
                }
                if (!/^[0-9]+$/.test(end.multiplicity)) {
                    for (type of architectureModel.componentTypes) {
                        if (type.cardinalityParameter !== undefined && end.multiplicity.includes(type.cardinalityParameter)) {
                            end.multiplicity = end.multiplicity.replace(type.cardinalityParameter, type.cardinalityValue);
                        }
                    }
                    //TODO: Change the eval
                    end.multiplicity = eval(end.multiplicity);
                    if (end.multiplicity > end.cardinality) {
                        inconsistencies.push({
                            node: end,
                            message: 'Multiplicity of connector end [' + this.core.getPath(end) + '] is greater than the cardinality of the corresponding component type.'
                        });
                    }
                }
                newMatchingFactor = (end.degree * end.cardinality) / end.multiplicity;
                if (/^[0-9]+$/.test(newMatchingFactor)) {
                    if (matchingFactor === -1) {
                        matchingFactor = newMatchingFactor;
                    } else if (matchingFactor !== newMatchingFactor) {
                        inconsistencies.push({
                            node: subPart,
                            message: 'Matching factors (cardinality * degree / multiplicity) of ends in connector motif [' + this.core.getPath(subPart) + '] are not equal.'
                        });
                        break;
                    }
                } else {
                    inconsistencies.push({
                        node: end,
                        message: 'Matching factor (cardinality * degree / multiplicity) [' + newMatchingFactor +'] of connector end [' + this.core.getPath(end) + '] is not a non-negative integer.'
                    });
                }
            }
        }
        return inconsistencies;

    };

    JavaBIPEngine.prototype.checkConsistency = function (architectureModel, nodes) {
        var self = this,
            subPart, node, srcNode, end, connector;

        /*1. Checks whether multiplicities are less or equal to corresponding cardinalities
        2. Checks equality of matching factors of the same connector */
        for (subPart of architectureModel.connections) {
            node = nodes[self.core.getPointerPath(subPart, 'src')];
            if (self.getMetaType(node) !== self.META.Connector) {
                node.cardinality = nodes[self.core.getPointerPath(subPart, 'dst')].cardinality;
            }
        }
        for (subPart of architectureModel.subConnectors) {
            node = nodes[self.core.getPointerPath(subPart, 'dst')];
            srcNode = nodes[self.core.getPointerPath(node, 'src')];
            end = nodes[self.core.getPointerPath(subPart, 'src')];
            if (architectureModel.connectors.includes(node)) {
                node.ends.push(end);
                end.connector = node;
            } else if (architectureModel.connectorEnds.includes(srcNode)) {
                for (connector in architectureModel.connectors) {
                    if (connector.ends.includes(srcNode)) {
                        connector.ends.push(end);
                        end.connector = connector;
                    }
                }
            }
        }
        return self.checkConnectorConsistency(architectureModel);
    };

    JavaBIPEngine.prototype.generateTestInfo = function (architectureModel, path) {
        var self = this,
        currentConfig = this.getCurrentConfig(),
            info = {
            className: self.core.getAttribute(self.activeNode, 'name'),
            path: path,
            componentType: architectureModel.componentTypes,
            noOfRequiredTransitions: currentConfig['transitions']
        };
        info.className = info.className.replace(/\s+/g, '');
        self.logger.debug('Engine test name: '+ info.className);
        return info;
    };

    JavaBIPEngine.prototype.checkMultiplicityAndDegree = function (connectorEnds, violations, cardinalityRegEx) {
        var end, multiplicity, degree,
        self = this;

        for (end of connectorEnds) {
            // Checks multiplicities and degrees
            multiplicity = self.core.getAttribute(end, 'multiplicity');
            degree = self.core.getAttribute(end, 'degree');
            try {
                ArithmeticExpressionParser.parse(multiplicity);
            } catch (e) {
                violations.push({
                    node: end,
                    message: 'Multiplicity [' + multiplicity + '] of component end [' + this.core.getPath(end) + '] is not a valid arithmetic expression with integers and lower-case parameters defined by the cardinalities of the model. Please change it.'
                });
            }
            try {
                ArithmeticExpressionParser.parse(degree);
            } catch (e) {
                violations.push({
                    node: end,
                    message: 'Degree [' + degree + '] of component end [' + this.core.getPath(end) + '] is not a valid arithmetic expression with integers and lower-case variables: '
                });
            }
            cardinalityRegEx.lastIndex = 0;
            if (!(cardinalityRegEx.test(multiplicity))) {
                violations.push({
                    node: end,
                    message: 'Multiplicity [' + multiplicity + '] of component end [' + this.core.getPath(end) + '] is not a natural number or an arithmetic expression of cardinality parameters.'
                });
            }
            cardinalityRegEx.lastIndex = 0;
            if (!cardinalityRegEx.test(degree)) {
                violations.push({
                        node: end,
                        message: 'Degree [' + degree + '] of component end [' + this.core.getPath(end) + '] is not a natural number or an arithmetic expression of cardinality parameters.'
                    });
            }
        }
        return violations;
    };

    JavaBIPEngine.prototype.hasViolations = function (nodes) {
        var violations = [],
        cardinalities = [],
        connectorEnds = [],
        self = this,
        nodePath,
        node, cardinality, violations_,
        regExpArray,
        cardinalityRegEx;

        /* Check that multiplicities, degrees are valid arithmetic expressions of cardinalities */
        for (nodePath in nodes) {
            node = nodes[nodePath];
            if (self.isMetaTypeOf(node, this.META.ComponentType)) {
                // Checks cardinality whether it is non zero positive integer or a lower-case character
                if (/^([a-z]|[1-9][0-9]*){1}$/.test(self.core.getAttribute(node, 'cardinality'))) {
                    cardinalities.push(self.core.getAttribute(node, 'cardinality'));
                } else {
                    violations.push({
                        node: node,
                        message: 'Cardinality [' + this.core.getAttribute(node, 'cardinality') + '] of component type [' + this.core.getAttribute(node, 'name') + '] is not a natural non-zero number or a character.'
                    });
                }
            } else if (self.isMetaTypeOf(node, this.META.Synchron) || self.isMetaTypeOf(node, this.META.Trigger)) {
                connectorEnds.push(node);
            }
        }
        regExpArray = ['^[', '+*\\-\\\/', '\(\)', '0-9'];
        for (cardinality of cardinalities) {
            if (/^[a-z]$/.test(cardinality)) {
                regExpArray.push(cardinality);
            }
        }
        regExpArray.push.apply(regExpArray, [']', '+$']);
        cardinalityRegEx = new RegExp(regExpArray.join(''), 'g');
        self.logger.debug(cardinalityRegEx);
        violations_ = self.checkMultiplicityAndDegree(connectorEnds, violations, cardinalityRegEx);
        if (violations_ > 0 ) {
            violations = violations.concat(violations_);
        }
        return violations;
    };
    return JavaBIPEngine;
});
