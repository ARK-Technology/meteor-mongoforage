/**
Packages

@module Packages
*/

/**
The PersistentMinimongo2 package

@class PersistentMinimongo2
@constructor
*/



/**
If the localstorage goes over 4.8 MB, trim the collections.

@property capLocalStorageSize
*/
var capLocalStorageSize = 4.8;

/**
If the localstorage goes over `capLocalStorageSize`, trim the current collection,
which wanted to add a new entry, by 50 entries.

@property trimCollectionBy
*/

/**** Glossary
 *
 * list: list of all _ids being cached in localforage
 */
var trimCollectionBy = 50;
var localforage = require('localforage');


PersistentMinimongo2 = function (collection, dbname) {
    var self = this;
    if (! (self instanceof PersistentMinimongo2))
            throw new Error('use "new" to construct a PersistentMinimongo2');

    self.key = 'minimongo__' + collection._name;
    self.changeKey = `${self.key}-changedDocs`;
    self.removedKey = `${self.key}-removedDocs`;
    self.col = collection;
    self.stats = { added: 0, removed: 0, changed: 0 };
    self.list = [];
    self.changeList = [];
    self.removedList = [];

    // config
    self.store = localforage.createInstance({
        name        : 'persistent-minimongo2-' + (dbname || 'db'),
        version     : 1.0,
        // size        : 4980736, // Size of database, in bytes. WebSQL-only for now.
        storeName   : 'minimongo',
        description : 'frozeman:persistent-minimongo2 data store'
    });

    // load from storage
    self.refresh(true);

    self.observeHandle = self.col.find({}).observe({
        added: function (doc) {
            var docId = self._getStringId(doc);

            // Check if the localstorage is to big and reduce the current collection by 50 items
            if(self.store.driver() === 'localStorageWrapper')
                self.capCollection();


            // add document id to tracking list and store
            if (!_.contains(self.list, docId)) {
                self.list.push(docId);

                // store copy of document into db, if not already there
                var key = self._makeDataKey(docId);
                self.store.setItem(key, doc, function(err, value) {
                    if(!err) {
                        ++self.stats.added;
                    }
                });

                // update the list
                self.store.setItem(self.key, self.list, function(err, value) {});
            }
        },

        removed: function (doc) {
            var docId = self._getStringId(doc);
            
            // if not in list, nothing to do
            if(!_.contains(self.list, docId))
                return;


            // remove document copy from local storage
            self.store.removeItem(self._makeDataKey(docId), function(err) {
                if(!err) {
                    ++self.stats.removed;
                }
            });

            // remove from list
            self.list = _.without(self.list, docId);

            // add to removedList
            self.removedList.push(docId);

            // if tracking list is empty, delete; else store updated copy
            if(self.list.length === 0) {
                self.store.removeItem(self.key, function(){});
            } else {
                self.store.setItem(self.key, self.list, function(){});
            }

            // TODO: if offline: store remove method call so it won't be forgotten if user reloads
            self.store.setItem(self.removedKey, self.removedList, function () {});
        },

        changed: function (newDoc, oldDoc) {
            var newDocId = self._getStringId(newDoc);

            // update document in local storage
            self.store.setItem(self._makeDataKey(newDocId), newDoc, function(err, value) {
                if(!err) {
                    ++self.stats.changed;
                }
            });
            console.log('change observed', newDoc, oldDoc, self.changeList);
        }
    });


    // Set up collection hooks for registering successful changes
    self.col.directUpdate = self.col.update;
    self.col.update = function(...args) {
        console.log('doing update', args);
        const docIds = self.col.find(args[0],{fields: {_id: 1}}).fetch().map(doc => {
            return self._getStringId(doc);
        });

        docIds.forEach((_id) => {
            console.log(self.changeList.indexOf(_id))
            if(self.changeList.indexOf(_id) === -1) {
                // Store the change request in case it won't make it to the server
                self.changeList.push(_id);
                console.log(_id, 'not found in changelist, adding',self.changeList);
            } else {
                console.log(_id, 'is already in changeList, ignore change call', self.changeList)
            }
        });
        // Store new change list in localforage
        self.store.setItem(self.changeKey, self.changeList, function() {});


        // If last argument is a function we need to swap it out for a wrapper fn
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : false;

        const newCallback = function(error, numberAffected) {
            if(!error) {
                // Update was success, remove from changeList, update store
                self.changeList = _.without(self.changeList, ...docIds);
                self.store.setItem(self.changeKey, self.changeList, function() {});
            }
            console.log('successLogger', error, numberAffected, self.changeList);

            if(callback) {
                callback(error, numberAffected);
            }
        };
        args.push(newCallback);

        return self.col.directUpdate(...args);
    }
};

PersistentMinimongo2.prototype = {
    constructor: PersistentMinimongo2,
    _getStats: function () {
        return this.stats;
    },
    _getKey: function () {
        return this.key;
    },
    /**
     * @summary Get a string version of _id from document. localforage only accepts
     *   string for keys, this returns the _id as-is if it's a string or extracts
     *   the string if _id is ObjectID
     * @param {Object} doc
     * @returns {string}
     * @private
     */
    _getStringId: function(doc) {
        if(doc._id && typeof doc._id === 'string') {
            // _id is string
            return doc._id;
        } else if(doc._id && typeof doc._id._str === 'string') {
            // _id is ObjectID
            return doc._id._str;
        } else {
            throw new Meteor.Error('wrong-_id','doc._id must be either string or ObjectID-like, is '+ doc._id);
        }
    },
  /**
   * Get a mongo-safe _id from document. Mongo _ids can only either be strings, or
   *    a Mongo.ObjectID object, when docs with _id as ObjectID are stored in localforage
   *    the object loses its Mongo.ObjectID constructor, this then returns a
   *    reconstructed ObjectID object
   * @param {Object} doc
   * @returns {string|Object}
   * @private
   */
    _getMongoId: function (doc) {
        if(doc._id && typeof doc._id === 'string') {
            // _id is string
            return doc._id;
        } else if(doc._id && typeof doc._id._str === 'string') {
            // _id is ObjectID
            return new Mongo.ObjectID(doc._id._str);
        } else {
            throw new Meteor.Error('wrong-_id','doc._id must be either string or ObjectID-like, is '+ doc._id);
        }
    },
    _makeDataKey: function (id) {
        return this.key + '__' + id;
    },
    /**
    Refresh the local storage
    
    @method refresh
    @return {String}
    */
    refresh: function (init) {
        var self = this;

        // Fetch list of unsynced updates
        self.store.getItem(self.changeKey, function (err, list) {
            if(!err) {
                self.changeList = list || [];
                console.log('started up with changeList', self.changeList);
            }
        });

        self.store.getItem(self.key, function(err, list) {
            if(!err) {

                self.list = list || [];
                self.stats.added = 0;

                if (!! list) {
                    var length = list.length;
                    var count = 0;
                    var newList = [];
                    _.each(list, function (id) {
                        self.store.getItem(self._makeDataKey(id), function(err, doc) {
                            if(!err) {
                                if(!! doc) {

                                    // Replace _id in case it's a Mongo.ObjectID
                                    var _id = doc._id = self._getMongoId(doc);
                                    var strId = self._getStringId(doc);

                                    var foundDoc = self.col.findOne({_id});

                                    if(foundDoc) {
                                        delete doc._id;
                                        self.col.update({_id}, {$set: doc});
                                    } else {
                                        _id = self.col.insert(doc, function(e, s) {
                                            if(e) {
                                                console.log('insert errored')
                                                if (e.error === 409) {
                                                    // Duplicate entry error, we need to update instead,
                                                    // unless another update was made while offline.
                                                    // This potentially overwrites changes made
                                                    if(self.changeList.indexOf(strId) > -1) {
                                                        //
                                                        console.log('found on changeList');
                                                        delete doc._id;
                                                        self.col.update({_id}, {$set: doc});
                                                    }
                                                } else {
                                                    console.error(e);
                                                }
                                            }
                                          });
                                    }
                                    doc._id = _id;
                                    // Keep track of _id's we've inserted
                                    newList.push(strId);
                                }
                            }
                            count++;
                        });
                    });

                    // do only after all items where checked
                    var intervalId = setInterval(function() {
                        if(count >= length) {
                            clearInterval(intervalId);

                            self.list = newList;

                            // if not initializing, check for deletes
                            if(! init) {
                            
                                self.col.find({}).forEach(function (doc) {
                                    var _id = self._getStringId(doc);
                                    if(! _.contains(self.list, _id)) {
                                        console.log(`Removing ${_id}`);
                                        self.col.remove({ _id });
                                    }
                                });
                            }

                            // if initializing, save cleaned list (if changed)
                            if(init && length !== self.list.length) {
                                // if tracking list is empty, delete; else store updated copy
                                if(self.list.length === 0) {
                                    self.store.removeItem(self.key, function(){});
                                } else {
                                    self.store.setItem(self.key, self.list, function(){});
                                }
                            }
                        }
                    }, 1);

                }
            }
        });
    },
    /**
    Gets the current localstorage size in MB
    
    @method localStorageSize
    @return {String} total localstorage size in MB
    */
    localStorageSize: function() {

        // function toSizeMB(info) {
        //   info.size = toMB(info.size).toFixed(2) + ' MB';
        //   return info;
        // }

        // var sizes = Object.keys(localStorage).map(toSize).map(toSizeMB);
        // console.table(sizes);

        var size = 0;
        if(localStorage) {
            _.each(Object.keys(localStorage), function(key){
                size += localStorage[key].length * 2 / 1024 / 1024;
            });
        }

        return size;
    },
    /**
    Check if the localstorage is to big and reduce the current collection by 50 items
    
    @method localStorageSize
    @return {String}
    */
    capCollection: function(){
        var _this = this;

        if(_this.localStorageSize() > capLocalStorageSize) {
            console.log(_this.localStorageSize(), _this.col.find({}).count());
            // find the first 50 entries and remove them
            _.each(_this.col.find({}, {limit: trimCollectionBy}).fetch(), function(item){
                _this.col.remove(item._id);
            });
        }
    }
};

// var persisters = [];
// var lpTimer = null;

// React on manual local storage changes
// Meteor.startup(function () {
//     $(window).bind('storage', function (e) {
//         console.log('STORAGE');
//         Meteor.clearTimeout(lpTimer);
//         lpTimer = Meteor.setTimeout(function () {
//             _.each(persisters, function (lp) {
//                 lp.refresh(false);
//             });
//         }, 250);
//     });
// });
