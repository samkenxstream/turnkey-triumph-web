/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {BaseRoom} from "./BaseRoom.js";
import {SyncWriter} from "./timeline/persistence/SyncWriter.js";
import {SendQueue} from "./sending/SendQueue.js";
import {WrappedError} from "../error.js"
import {Heroes} from "./members/Heroes.js";
import {AttachmentUpload} from "./AttachmentUpload.js";
import {DecryptionSource} from "../e2ee/common.js";

const EVENT_ENCRYPTED_TYPE = "m.room.encrypted";

export class Room extends BaseRoom {
    constructor(options) {
        super(options);
        const {pendingEvents} = options;
        this._syncWriter = new SyncWriter({roomId: this.id, fragmentIdComparer: this._fragmentIdComparer});
        this._sendQueue = new SendQueue({roomId: this.id, storage: this._storage, hsApi: this._hsApi, pendingEvents});
    }

    _setEncryption(roomEncryption) {
        if (super._setEncryption(roomEncryption)) {
            this._sendQueue.enableEncryption(this._roomEncryption);
            return true;
        }
        return false;
    }

    async prepareSync(roomResponse, membership, invite, newKeys, txn, log) {
        log.set("id", this.id);
        if (newKeys) {
            log.set("newKeys", newKeys.length);
        }
        let summaryChanges = this._summary.data.applySyncResponse(roomResponse, membership, this._user.id);
        if (membership === "join" && invite) {
            summaryChanges = summaryChanges.applyInvite(invite);
        }
        let roomEncryption = this._roomEncryption;
        // encryption is enabled in this sync
        if (!roomEncryption && summaryChanges.encryption) {
            log.set("enableEncryption", true);
            roomEncryption = this._createRoomEncryption(this, summaryChanges.encryption);
        }

        let retryEntries;
        let decryptPreparation;
        if (roomEncryption) {
            let eventsToDecrypt = roomResponse?.timeline?.events || [];
            // when new keys arrive, also see if any older events can now be retried to decrypt
            if (newKeys) {
                retryEntries = await this._getSyncRetryDecryptEntries(newKeys, roomEncryption, txn);
                if (retryEntries.length) {
                    log.set("retry", retryEntries.length);
                    eventsToDecrypt = eventsToDecrypt.concat(retryEntries.map(entry => entry.event));
                }
            }
            eventsToDecrypt = eventsToDecrypt.filter(event => {
                return event?.type === EVENT_ENCRYPTED_TYPE;
            });
            if (eventsToDecrypt.length) {
                decryptPreparation = await roomEncryption.prepareDecryptAll(
                    eventsToDecrypt, newKeys, DecryptionSource.Sync, txn);
            }
        }

        return {
            roomEncryption,
            summaryChanges,
            decryptPreparation,
            decryptChanges: null,
            retryEntries
        };
    }

    async afterPrepareSync(preparation, parentLog) {
        if (preparation.decryptPreparation) {
            await parentLog.wrap("decrypt", async log => {
                log.set("id", this.id);
                preparation.decryptChanges = await preparation.decryptPreparation.decrypt();
                preparation.decryptPreparation = null;
            }, parentLog.level.Detail);
        }
    }

    /** @package */
    async writeSync(roomResponse, isInitialSync, {summaryChanges, decryptChanges, roomEncryption, retryEntries}, txn, log) {
        log.set("id", this.id);
        const isRejoin = summaryChanges.isNewJoin(this._summary.data);
        if (isRejoin) {
            // remove all room state before calling syncWriter,
            // so no old state sticks around
            txn.roomState.removeAllForRoom(this.id);
            txn.roomMembers.removeAllForRoom(this.id);
            // TODO: this should be done in ArchivedRoom
            txn.archivedRoomSummary.remove(this.id);
        }
        const {entries: newEntries, newLiveKey, memberChanges} =
            await log.wrap("syncWriter", log => this._syncWriter.writeSync(roomResponse, isRejoin, txn, log), log.level.Detail);
        let allEntries = newEntries;
        if (decryptChanges) {
            const decryption = await log.wrap("decryptChanges", log => decryptChanges.write(txn, log));
            log.set("decryptionResults", decryption.results.size);
            log.set("decryptionErrors", decryption.errors.size);
            if (this._isTimelineOpen) {
                await decryption.verifySenders(txn);
            }
            decryption.applyToEntries(newEntries);
            if (retryEntries?.length) {
                decryption.applyToEntries(retryEntries);
                allEntries = retryEntries.concat(allEntries);
            }
        }
        log.set("allEntries", allEntries.length);
        let shouldFlushKeyShares = false;
        // pass member changes to device tracker
        if (roomEncryption && this.isTrackingMembers && memberChanges?.size) {
            shouldFlushKeyShares = await roomEncryption.writeMemberChanges(memberChanges, txn, log);
            log.set("shouldFlushKeyShares", shouldFlushKeyShares);
        }
        // also apply (decrypted) timeline entries to the summary changes
        summaryChanges = summaryChanges.applyTimelineEntries(
            allEntries, isInitialSync, !this._isTimelineOpen, this._user.id);
        
        // only archive a room if we had previously joined it
        if (summaryChanges.membership === "leave" && this.membership === "join") {
            txn.roomSummary.remove(this.id);
            summaryChanges = this._summary.writeArchivedData(summaryChanges, txn);
        } else {
            // write summary changes, and unset if nothing was actually changed
            summaryChanges = this._summary.writeData(summaryChanges, txn);
        }
        if (summaryChanges) {
            log.set("summaryChanges", summaryChanges.diff(this._summary.data));
        }
        // fetch new members while we have txn open,
        // but don't make any in-memory changes yet
        let heroChanges;
        // if any hero changes their display name, the summary in the room response
        // is also updated, which will trigger a RoomSummary update
        // and make summaryChanges non-falsy here
        if (summaryChanges?.needsHeroes) {
            // room name disappeared, open heroes
            if (!this._heroes) {
                this._heroes = new Heroes(this._roomId);
            }
            heroChanges = await this._heroes.calculateChanges(summaryChanges.heroes, memberChanges, txn);
        }
        let removedPendingEvents;
        if (Array.isArray(roomResponse.timeline?.events)) {
            removedPendingEvents = this._sendQueue.removeRemoteEchos(roomResponse.timeline.events, txn, log);
        }
        return {
            summaryChanges,
            roomEncryption,
            newEntries,
            updatedEntries: retryEntries || [],
            newLiveKey,
            removedPendingEvents,
            memberChanges,
            heroChanges,
            shouldFlushKeyShares,
        };
    }

    /**
     * @package
     * Called with the changes returned from `writeSync` to apply them and emit changes.
     * No storage or network operations should be done here.
     */
    afterSync(changes, log) {
        const {
            summaryChanges, newEntries, updatedEntries, newLiveKey,
            removedPendingEvents, memberChanges,
            heroChanges, roomEncryption
        } = changes;
        log.set("id", this.id);
        this._syncWriter.afterSync(newLiveKey);
        this._setEncryption(roomEncryption);
        if (memberChanges.size) {
            if (this._changedMembersDuringSync) {
                for (const [userId, memberChange] of memberChanges.entries()) {
                    this._changedMembersDuringSync.set(userId, memberChange.member);
                }
            }
            if (this._memberList) {
                this._memberList.afterSync(memberChanges);
            }
            if (this._timeline) {
                for (const [userId, memberChange] of memberChanges.entries()) {
                    if (userId === this._user.id) {
                        this._timeline.updateOwnMember(memberChange.member);
                        break;
                    }
                }
            }
        }
        let emitChange = false;
        if (summaryChanges) {
            this._summary.applyChanges(summaryChanges);
            if (!this._summary.data.needsHeroes) {
                this._heroes = null;
            }
            emitChange = true;
        }
        if (this._heroes && heroChanges) {
            const oldName = this.name;
            this._heroes.applyChanges(heroChanges, this._summary.data);
            if (oldName !== this.name) {
                emitChange = true;
            }
        }
        if (emitChange) {
            this._emitUpdate();
        }
        if (this._timeline) {
            // these should not be added if not already there
            this._timeline.replaceEntries(updatedEntries);
            this._timeline.addOrReplaceEntries(newEntries);
        }
        if (this._observedEvents) {
            this._observedEvents.updateEvents(updatedEntries);
            this._observedEvents.updateEvents(newEntries);
        }
        if (removedPendingEvents) {
            this._sendQueue.emitRemovals(removedPendingEvents);
        }
    }

    needsAfterSyncCompleted({shouldFlushKeyShares}) {
        return shouldFlushKeyShares;
    }

    /**
     * Only called if the result of writeSync had `needsAfterSyncCompleted` set.
     * Can be used to do longer running operations that resulted from the last sync,
     * like network operations.
     */
    async afterSyncCompleted(changes, log) {
        log.set("id", this.id);
        if (this._roomEncryption) {
            await this._roomEncryption.flushPendingRoomKeyShares(this._hsApi, null, log);
        }
    }

    /** @package */
    start(pendingOperations, parentLog) {
        if (this._roomEncryption) {
            const roomKeyShares = pendingOperations?.get("share_room_key");
            if (roomKeyShares) {
                // if we got interrupted last time sending keys to newly joined members
                parentLog.wrapDetached("flush room keys", log => {
                    log.set("id", this.id);
                    return this._roomEncryption.flushPendingRoomKeyShares(this._hsApi, roomKeyShares, log);
                });
            }
        }
        
        this._sendQueue.resumeSending(parentLog);
    }

    /** @package */
    async load(summary, txn, log) {
        try {
            super.load(summary, txn, log);
            this._syncWriter.load(txn, log);
        } catch (err) {
            throw new WrappedError(`Could not load room ${this._roomId}`, err);
        }
    }

    _writeGapFill(gapChunk, txn, log) {
        const removedPendingEvents = this._sendQueue.removeRemoteEchos(gapChunk, txn, log);
        return removedPendingEvents;
    }

    _applyGapFill(removedPendingEvents) {
        this._sendQueue.emitRemovals(removedPendingEvents);
    }

    /** @public */
    sendEvent(eventType, content, attachments, log = null) {
        this._platform.logger.wrapOrRun(log, "send", log => {
            log.set("id", this.id);
            return this._sendQueue.enqueueEvent(eventType, content, attachments, log);
        });
    }

    /** @public */
    async ensureMessageKeyIsShared(log = null) {
        if (!this._roomEncryption) {
            return;
        }
        return this._platform.logger.wrapOrRun(log, "ensureMessageKeyIsShared", log => {
            log.set("id", this.id);
            return this._roomEncryption.ensureMessageKeyIsShared(this._hsApi, log);
        });
    }

    get isUnread() {
        return this._summary.data.isUnread;
    }

    get notificationCount() {
        return this._summary.data.notificationCount;
    }
    
    get highlightCount() {
        return this._summary.data.highlightCount;
    }

    get isTrackingMembers() {
        return this._summary.data.isTrackingMembers;
    }

    async _getLastEventId() {
        const lastKey = this._syncWriter.lastMessageKey;
        if (lastKey) {
            const txn = await this._storage.readTxn([
                this._storage.storeNames.timelineEvents,
            ]);
            const eventEntry = await txn.timelineEvents.get(this._roomId, lastKey);
            return eventEntry?.event?.event_id;
        }
    }

    async clearUnread(log = null) {
        if (this.isUnread || this.notificationCount) {
            return await this._platform.logger.wrapOrRun(log, "clearUnread", async log => {
                log.set("id", this.id);
                const txn = await this._storage.readWriteTxn([
                    this._storage.storeNames.roomSummary,
                ]);
                let data;
                try {
                    data = this._summary.writeClearUnread(txn);
                } catch (err) {
                    txn.abort();
                    throw err;
                }
                await txn.complete();
                this._summary.applyChanges(data);
                this._emitUpdate();
                
                try {
                    const lastEventId = await this._getLastEventId();
                    if (lastEventId) {
                        await this._hsApi.receipt(this._roomId, "m.read", lastEventId);
                    }
                } catch (err) {
                    // ignore ConnectionError
                    if (err.name !== "ConnectionError") {
                        throw err;
                    }
                }
            });
        }
    }

    /* called by BaseRoom to pass pendingEvents when opening the timeline */
    _getPendingEvents() {
        return this._sendQueue.pendingEvents;
    }

    /** @package */
    writeIsTrackingMembers(value, txn) {
        return this._summary.writeIsTrackingMembers(value, txn);
    }

    /** @package */
    applyIsTrackingMembersChanges(changes) {
        this._summary.applyChanges(changes);
    }

    createAttachment(blob, filename) {
        return new AttachmentUpload({blob, filename, platform: this._platform});
    }

    dispose() {
        super.dispose();
        this._sendQueue.dispose();
    }
}
