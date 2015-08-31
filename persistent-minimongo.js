/**
Packages

@module Packages
*/

/**
The PersistentMinimongo package

@class PersistentMinimongo
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
var trimCollectionBy = 50;



PersistentMinimongo = function (collection, dbname) {
    var self = this;
    if (! (self instanceof PersistentMinimongo))
            throw new Error('use "new" to construct a PersistentMinimongo');

    self.key = 'minimongo__' + collection._name;
    self.col = collection;
    self.cur = self.col.find({});
    self.stats = { added: 0, removed: 0, changed: 0 };

    persisters.push(self);

    localforage.config({
        name        : 'persistent-minimongo2',
        version     : 1.0,
        // size        : 4980736, // Size of database, in bytes. WebSQL-only for now.
        storeName   : dbname || 'minimongo',
        description : 'frozeman:persistent-minimongo2 data store'
    });

    // load from storage
    self.refresh(true);

    self.cur.observe({
        added: function (doc) {

            // Check if the localstorage is to big and reduce the current collection by 50 items
            if(localforage.driver() === 'localStorageWrapper')
                self.capCollection();

            // get or initialize tracking list
            localforage.getItem(self.key, function(err, list) {
                if(!err) {

                    if (! list)
                        list = [];

                    // add document id to tracking list and store
                    if (! _.contains(list, doc._id)) {
                        list.push(doc._id);

                        localforage.setItem(self.key, list, function(err, value) {
                            if(!err) {

                                // store copy of document into local storage, if not already there
                                var key = self._makeDataKey(doc._id);
                                localforage.setItem(key, doc, function(err, value) {
                                    if(!err) {
                                        ++self.stats.added;
                                    }
                                });
                            }
                        });
                    }

                }
            });
        },

        removed: function (doc) {
            localforage.getItem(self.key, function(err, list) {
                if(!err) {

                    // if not in list, nothing to do
                    if(! _.contains(list, doc._id))
                        return;

                    // remove from list
                    list = _.without(list, doc._id);

                    // remove document copy from local storage
                    localforage.removeItem(self._makeDataKey(doc._id), function(err) {
                        if(!err) {

                            // if tracking list is empty, delete; else store updated copy
                            if(list.length === 0) {
                                localforage.removeItem(self.key, function(){});
                            } else {
                                localforage.setItem(self.key, list, function(){});
                            }

                            ++self.stats.removed;
                        }
                    });

                }
            });
        },

        changed: function (newDoc, oldDoc) {
            // update document in local storage
            localforage.setItem(self._makeDataKey(newDoc._id), newDoc, function(err, value) {
                if(!err) {
                    ++self.stats.changed;
                }
            });
        }
    });
};

PersistentMinimongo.prototype = {
    constructor: PersistentMinimongo,
    _getStats: function () {
        return this.stats;
    },
    _getKey: function () {
        return this.key;
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
        localforage.getItem(self.key, function(err, list) {
            if(!err) {

                self.stats.added = 0;

                if (!! list) {
                    var length = list.length;
                    var count = 0;
                    var newList = [];
                    _.each(list, function (id) {
                        localforage.getItem(self._makeDataKey(id), function(err, doc) {
                            if(!err) {
                                if(!! doc) {
                                    var id = doc._id;
                                    delete doc._id;
                                    self.col.upsert({ _id: id}, {$set: doc});

                                    newList.push(id);
                                }
                            }
                            count++;
                        });
                    });

                    // do only after all items where checked
                    var intervalId = setInterval(function() {
                        if(count >= length) {
                            clearInterval(intervalId);

                            // if not initializing, check for deletes
                            if(! init) {
                            
                                self.col.find({}).forEach(function (doc) {
                                    if(! _.contains(newList, doc._id))
                                        self.col.remove({ _id: doc._id });
                                });
                            }

                            // if initializing, save cleaned list (if changed)
                            if(init && length !== newList.length) {
                                // if tracking list is empty, delete; else store updated copy
                                if(newList.length === 0) {
                                    localforage.removeItem(self.key, function(){});
                                } else {
                                    localforage.setItem(self.key, newList, function(){});
                                }
                            }
                        }
                    }, 10);

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

var persisters = [];
var lpTimer = null;

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
