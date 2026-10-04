// Hekaya Connect — clock sync with the show server (phones, admin and theatre screen).
// Asks the server for its time several times and keeps the reply with the shortest round trip,
// which gives the most accurate offset. serverNow() then reads "show time" on this device.
(function (root) {
  root.HekayaClock = function (socket, opts) {
    opts = opts || {};
    var localNow = function () { return (performance.timeOrigin || 0) + performance.now(); };
    var api = { offset: 0, rtt: null, synced: false };
    var busy = false;

    api.now = function () { return localNow() + api.offset; };

    function once() {
      return new Promise(function (resolve) {
        var t0 = localNow();
        socket.timeout(2000).emit('sync', t0, function (err, st) {
          if (err || typeof st !== 'number') return resolve(null);
          var t1 = localNow();
          resolve({ rtt: t1 - t0, offset: st - (t0 + t1) / 2 });
        });
      });
    }

    api.sync = async function (samples) {
      if (busy || !socket.connected) return;
      busy = true;
      var best = null;
      for (var i = 0; i < (samples || 6); i++) {
        var r = await once();
        if (r && (!best || r.rtt < best.rtt)) best = r;
        await new Promise(function (ok) { setTimeout(ok, 50); });
      }
      busy = false;
      if (best) {
        api.offset = best.offset;
        api.rtt = Math.round(best.rtt);
        api.synced = true;
        if (opts.onSynced) opts.onSynced(api);
      }
    };

    // Rough estimate from any server timestamp until a proper sync completes.
    api.hint = function (serverTime) {
      if (!api.synced && typeof serverTime === 'number') api.offset = serverTime - localNow();
    };

    socket.on('connect', function () { api.sync(8); });
    setInterval(function () { api.sync(5); }, opts.everyMs || 15000);
    return api;
  };
})(typeof self !== 'undefined' ? self : this);
