const P2PNode = require('./libp2p_node')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const Multiaddr = require('multiaddr')
const Multihash = require('multihashes')
const pb = require('../protobuf')
const pull = require('pull-stream')
const { DEFAULT_LISTEN_ADDR, PROTOCOLS } = require('./constants')
const {
  protoStreamEncode,
  protoStreamDecode,
  peerInfoProtoMarshal,
  lookupResponseToPeerInfo,
  pullToPromise,
  pullRepeatedly
} = require('./util')

import type { Connection } from 'interface-connection'
import type { PullStreamSource } from './util'

class MediachainNode {
  p2p: P2PNode
  directory: ?PeerInfo

  constructor (peerId: PeerId, dirInfo: ?PeerInfo, listenAddrs: Array<Multiaddr> = [DEFAULT_LISTEN_ADDR]) {
    const peerInfo = new PeerInfo(peerId)
    listenAddrs.forEach((addr: Multiaddr) => {
      peerInfo.multiaddr.add(addr)
    })

    this.p2p = new P2PNode(peerInfo)
    this.directory = dirInfo
    this.p2p.handle(PROTOCOLS.node.ping, this.pingHandler.bind(this))
  }

  start (): Promise<void> {
    return this.p2p.start()
  }

  stop (): Promise<void> {
    return this.p2p.stop()
  }

  get peerInfo (): PeerInfo {
    return this.p2p.peerInfo
  }

  register (): Promise<boolean> {
    if (this.directory == null) {
      return Promise.reject(new Error('No known directory server, cannot register'))
    }

    const abortable = this.p2p.newAbortable()

    const req = {
      info: peerInfoProtoMarshal(this.p2p.peerInfo)
    }

    return this.p2p.dialByPeerInfo(this.directory, PROTOCOLS.dir.register)
      .then(conn => {
        pull(
          pullRepeatedly(req, 5000 * 60),
          abortable,
          protoStreamEncode(pb.dir.RegisterPeer),
          conn,
          pull.onEnd(() => {
            console.log('registration connection ended')
          })
        )
        return true
      })
  }

  lookup (peerId: string | PeerId): Promise<?PeerInfo> {
    if (this.directory == null) {
      return Promise.reject(new Error('No known directory server, cannot lookup'))
    }

    if (peerId instanceof PeerId) {
      peerId = peerId.toB58String()
    } else {
      // validate that string arguments are legit multihashes
      try {
        Multihash.fromB58String(peerId)
      } catch (err) {
        return Promise.reject(new Error(`Peer id is not a valid multihash: ${err.message}`))
      }
    }

    return this.p2p.dialByPeerInfo(this.directory, PROTOCOLS.dir.lookup)
      .then(conn => pullToPromise(
        pull.values([{id: peerId}]),
        protoStreamEncode(pb.dir.LookupPeerRequest),
        conn,
        protoStreamDecode(pb.dir.LookupPeerResponse),
        pull.map(lookupResponseToPeerInfo),
        )
      )
  }

  _lookupIfNeeded (peer: PeerInfo | PeerId | string): Promise<?PeerInfo> {
    if (peer instanceof PeerInfo) {
      return Promise.resolve(peer)
    }
    return this.lookup(peer)
  }

  openConnection (peer: PeerInfo | PeerId | string, protocol: string): Promise<Connection> {
    return this._lookupIfNeeded(peer)
      .then(maybePeer => {
        if (!maybePeer) throw new Error(`Unable to locate peer ${peer}`)
        return maybePeer
      })
      .then(peerInfo => this.p2p.dialByPeerInfo(peerInfo, protocol))
  }

  ping (peer: PeerInfo | PeerId | string): Promise<boolean> {
    return this.openConnection(peer, PROTOCOLS.node.ping)
      .then((conn: Connection) => pullToPromise(
        pull.values([{}]),
        protoStreamEncode(pb.node.Ping),
        conn,
        protoStreamDecode(pb.node.Pong),
        pull.map(_ => { return true })
      ))
  }

  pingHandler (conn: Connection) {
    pull(
      conn,
      protoStreamDecode(pb.node.Ping),
      protoStreamEncode(pb.node.Pong),
      conn
    )
  }

  remoteQuery (peer: PeerInfo | PeerId | string, queryString: string): Promise<PullStreamSource> {
    return this.openConnection(peer, PROTOCOLS.node.query)
      .then(conn => pull(
        pull.values([{query: queryString}]),
        protoStreamEncode(pb.node.QueryRequest),
        conn,
        protoStreamDecode(pb.node.QueryResult)
      ))
  }
}

module.exports = MediachainNode
