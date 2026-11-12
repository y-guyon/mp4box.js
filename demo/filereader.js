var file = {};
file.mp4boxfile = null;
file.objectToLoad = null;
file.objectIsFile = false;
file.fancytree = null;

Log.setLogLevel(Log.debug);

function createBoxView() {
  var treeboxes = getFancyTreeDataFromBoxes(file.mp4boxfile.boxes);
  file.fancytree.reload(treeboxes);
  var boxnodes = { title: 'file', children: treeboxes };
  createBoxTreeMapSVG(boxnodes);
  createBoxPartition(boxnodes);
}

function resetBoxView() {
  file.fancytree.reload([]);
  d3.select('#boxmapview').html('');
  d3.select('#boxpartitionview').html('');
}

function finalizeAnalyzerUI(fileobj, loadbutton, success) {
  loadbutton.button('enable');
  if (success) {
    createBoxView();
    buildAssociationView(fileobj.mp4boxfile);
    buildItemTable(fileobj.mp4boxfile.items);
    buildSampleView();
    displayMovieInfo(fileobj.mp4boxfile.getInfo(), document.getElementById('movieview'), false);
    buildSegmentView(fileobj);
    buildEntityGroupTable(fileobj.mp4boxfile.entity_groups);
  } else {
    resetBoxView();
    $('#associationview').html('');
    $('#itemview').html('');
    resetSampleView();
    $('#movieview').html('');
    resetSegmentView();
    $('#entitygroupview').html('');
  }
}

function peekBytesFromFile(mp4boxfile, offset, size) {
  var i, buf, mdat, mdatStart;
  if (!mp4boxfile || !size || size <= 0) return null;
  if (mp4boxfile.stream && mp4boxfile.stream.buffers) {
    for (i = 0; i < mp4boxfile.stream.buffers.length; i++) {
      buf = mp4boxfile.stream.buffers[i];
      if (buf.fileStart <= offset && offset + size <= buf.fileStart + buf.byteLength) {
        return new Uint8Array(buf, offset - buf.fileStart, size);
      }
    }
  }
  if (mp4boxfile.mdats) {
    for (i = 0; i < mp4boxfile.mdats.length; i++) {
      mdat = mp4boxfile.mdats[i];
      mdatStart = mdat.start + mdat.hdr_size;
      if (mdat.data && mdatStart <= offset && offset + size <= mdat.start + mdat.size) {
        return mdat.data.subarray(offset - mdatStart, offset - mdatStart + size);
      }
      if (mdat.stream && mdat.stream.buffers) {
        for (var j = 0; j < mdat.stream.buffers.length; j++) {
          buf = mdat.stream.buffers[j];
          var bStart = mdatStart + buf.fileStart;
          if (bStart <= offset && offset + size <= bStart + buf.byteLength) {
            return new Uint8Array(buf, offset - bStart, size);
          }
        }
        if (mdatStart <= offset && offset + size <= mdat.start + mdat.size) {
          var out = new Uint8Array(size);
          var copied = 0;
          for (var j2 = 0; j2 < mdat.stream.buffers.length && copied < size; j2++) {
            var buf2 = mdat.stream.buffers[j2];
            var bStart2 = mdatStart + buf2.fileStart;
            var bEnd2 = bStart2 + buf2.byteLength;
            var curOff = offset + copied;
            if (curOff >= bStart2 && curOff < bEnd2) {
              var take = Math.min(size - copied, bEnd2 - curOff);
              out.set(new Uint8Array(buf2, curOff - bStart2, take), copied);
              copied += take;
            }
          }
          if (copied === size) return out;
        }
      }
    }
  }
  return null;
}

function parseLpcoBoxesFallback(lpcoBox) {
  if (!lpcoBox) return [];
  if (lpcoBox.boxes && lpcoBox.boxes.length > 0) return lpcoBox.boxes;
  var data = lpcoBox.data;
  if (!data || data.length < 8) return [];
  var boxes = [];
  var pos = 0;
  while (pos + 8 <= data.length) {
    var sz =
      ((data[pos] << 24) >>> 0) +
      ((data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]);
    var type = String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]);
    if (sz < 8 || pos + sz > data.length) break;
    boxes.push({ type: type, size: sz, start: (lpcoBox.start || 0) + (lpcoBox.hdr_size || 8) + pos });
    pos += sz;
  }
  return boxes;
}

function parseLpmaFallback(lpmaBox) {
  if (!lpmaBox) return null;
  if (lpmaBox.entries) {
    return { flags: lpmaBox.flags || 0, entries: lpmaBox.entries };
  }
  var data = lpmaBox.data;
  if (!data || data.length < 6) return null;
  var flags = (data[1] << 16) | (data[2] << 8) | data[3];
  var entryCount = (data[4] << 8) | data[5];
  var pos = 6;
  var entries = [];
  for (var i = 0; i < entryCount && pos + 5 <= data.length; i++) {
    var targetId =
      ((data[pos] << 24) >>> 0) +
      ((data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]);
    var assocCount = data[pos + 4];
    pos += 5;
    var associations = [];
    for (var j = 0; j < assocCount && pos < data.length; j++) {
      var b0 = data[pos++];
      var essential = (b0 >> 7) & 1;
      var source = (b0 >> 6) & 1;
      var high6 = b0 & 0x3f;
      if (source === 0) {
        var propIndex = high6;
        if (flags & 2) {
          if (pos >= data.length) break;
          propIndex = (high6 << 8) | data[pos++];
        }
        associations.push({ essential: essential, source: 0, property_index: propIndex });
      } else {
        if (pos + 4 > data.length) break;
        var fourcc = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
        pos += 4;
        associations.push({ essential: essential, source: 1, property_4cc: fourcc });
      }
    }
    entries.push({ target_id: targetId, associations: associations });
  }
  return { flags: flags, entries: entries };
}

function detectTrackLayers(mp4boxfile, trak) {
  var entries =
    (trak.mdia &&
      trak.mdia.minf &&
      trak.mdia.minf.stbl &&
      trak.mdia.minf.stbl.stsd &&
      trak.mdia.minf.stbl.stsd.entries) ||
    [];
  var isAv2 = false;
  var i, j, se;
  for (i = 0; i < entries.length; i++) {
    se = entries[i];
    if (se.type === 'av2E' || se.type === 'av2e' || se.av2C || se.av2c) {
      isAv2 = true;
    } else if (se.boxes) {
      for (j = 0; j < se.boxes.length; j++) {
        if (se.boxes[j].type === 'av2C' || se.boxes[j].type === 'av2c') {
          isAv2 = true;
          break;
        }
      }
    }
  }

  var layers = [];
  if (isAv2) {
    var pairMap = {};
    function addPair(x, m) {
      if (x < 0 || x >= 31 || m < 0 || m >= 8) return;
      var key = x + ':' + m;
      if (!pairMap[key]) {
        pairMap[key] = { x: x, m: m };
      }
    }
    function scanAv2Obus(bytes) {
      if (!bytes || !bytes.length) return;
      var pos = 0;
      while (pos < bytes.length) {
        var val = 0;
        var shift = 0;
        var idx = pos;
        var ok = false;
        for (var k = 0; k < 8 && idx < bytes.length; k++) {
          var b = bytes[idx++];
          val |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) {
            ok = true;
            break;
          }
          shift += 7;
        }
        if (!ok || val <= 0 || idx + val > bytes.length) break;
        var obuStart = idx;
        var obuEnd = idx + val;
        pos = obuEnd;

        var hdrByte1 = bytes[obuStart];
        var hasExt = (hdrByte1 >> 7) & 1;
        var obuType = (hdrByte1 >> 2) & 0x1f;
        var xlayerId = 0;
        var mlayerId = 0;
        var payloadStart = obuStart + 1;
        if (hasExt) {
          if (obuStart + 1 >= obuEnd) continue;
          var hdrByte2 = bytes[obuStart + 1];
          mlayerId = (hdrByte2 >> 5) & 0x7;
          xlayerId = hdrByte2 & 0x1f;
          payloadStart = obuStart + 2;
        }
        if (obuType === 1) {
          if (xlayerId < 31) addPair(xlayerId, 0);
        } else if (obuType === 16 && payloadStart < obuEnd) {
          var bitPos = 0;
          function rBit() {
            var byteIdx = payloadStart + (bitPos >> 3);
            if (byteIdx >= obuEnd) return 0;
            var v = (bytes[byteIdx] >> (7 - (bitPos & 7))) & 1;
            bitPos++;
            return v;
          }
          function rBits(n) {
            var v = 0;
            for (var bi = 0; bi < n; bi++) v = v * 2 + rBit();
            return v;
          }
          function rUvlc() {
            var lz = 0;
            while (lz < 32) {
              if (rBit() === 1) break;
              lz++;
            }
            if (lz === 0) return 0;
            if (lz >= 32) return 0xffffffff;
            return rBits(lz) + Math.pow(2, lz) - 1;
          }
          function rRg(n) {
            for (var q = 0; q < 32; q++) {
              if (rBit() === 0) {
                return (q << n) + rBits(n);
              }
            }
            return 0;
          }
          function byteAlign() {
            while ((bitPos & 7) !== 0) bitPos++;
          }
          function rLeb128() {
            byteAlign();
            var valL = 0;
            var shiftL = 0;
            for (var li = 0; li < 8; li++) {
              var bL = rBits(8);
              valL |= (bL & 0x7f) << shiftL;
              if ((bL & 0x80) === 0) break;
              shiftL += 7;
            }
            return valL >>> 0;
          }
          function parseXlayerInfo(xlid) {
            var repPresent = rBit();
            var purposePresent = rBit();
            var colorPresent = rBit();
            var embPresent = rBit();
            if (repPresent) {
              rUvlc();
              rUvlc();
              var fmtPresent = rBit();
              var cropPresent = rBit();
              if (fmtPresent) {
                rUvlc();
                rUvlc();
              }
              if (cropPresent) {
                rUvlc();
                rUvlc();
                rUvlc();
                rUvlc();
              }
            }
            if (purposePresent) rBits(7);
            if (colorPresent) {
              var cidc = rRg(2);
              if (cidc === 0) rBits(24);
              rBit();
            }
            byteAlign();
            if (embPresent) {
              var mlayerMap = rBits(8);
              if (mlayerMap === 0) {
                addPair(xlid, 0);
              } else {
                for (var mi = 0; mi < 8; mi++) {
                  if ((mlayerMap >> mi) & 1) addPair(xlid, mi);
                }
              }
            } else {
              addPair(xlid, 0);
            }
          }

          if (xlayerId === 31) {
            rBits(3);
            var xmap = rBits(31);
            var xlayers = [];
            for (var xi = 0; xi < 31; xi++) {
              if (Math.floor(xmap / Math.pow(2, xi)) % 2 === 1) {
                xlayers.push(xi);
                addPair(xi, 0);
              }
            }
            var aggPresent = rBit();
            var ptlPresent = rBit();
            var globalPayloadPresent = rBit();
            var depXlayers = rBit();
            rBit();
            rBits(7);
            rBit();
            rBit();
            rBits(3);
            rBits(5);
            if (aggPresent) rBits(16);
            if (ptlPresent) {
              for (var xi2 = 0; xi2 < xlayers.length; xi2++) rBits(16);
            }
            if (globalPayloadPresent) {
              for (var xi3 = 0; xi3 < xlayers.length; xi3++) {
                var dSize = rLeb128();
                var subStart = bitPos;
                if (depXlayers && xlayers[xi3] > 0) rBits(xlayers[xi3]);
                parseXlayerInfo(xlayers[xi3]);
                bitPos = subStart + dSize * 8;
              }
            }
          } else {
            addPair(xlayerId, 0);
            rBits(3);
            rBits(3);
            var localPtl = rBit();
            rBit();
            if (localPtl) rBits(16);
            rBits(3);
            rBits(5);
            parseXlayerInfo(xlayerId);
          }
        } else if (
          obuType === 3 ||
          obuType === 4 ||
          obuType === 5 ||
          obuType === 6 ||
          obuType === 7 ||
          obuType === 10 ||
          obuType === 11 ||
          obuType === 12 ||
          obuType === 13 ||
          obuType === 14 ||
          obuType === 19 ||
          obuType === 21
        ) {
          if (xlayerId < 31) addPair(xlayerId, mlayerId);
        }
      }
    }

    for (i = 0; i < entries.length; i++) {
      se = entries[i];
      var av2C = se.av2C;
      if (!av2C && se.boxes) {
        for (j = 0; j < se.boxes.length; j++) {
          if (se.boxes[j].type === 'av2C') {
            av2C = se.boxes[j];
            break;
          }
        }
      }
      if (av2C) {
        if (av2C.config_obus) {
          scanAv2Obus(av2C.config_obus);
        } else if (av2C.data && av2C.data.length > 2) {
          scanAv2Obus(av2C.data.subarray(2));
        }
      }
    }

    if (trak.samples && trak.samples.length > 0) {
      var maxSamples = Math.min(trak.samples.length, 30);
      for (i = 0; i < maxSamples; i++) {
        var sample = trak.samples[i];
        var sBytes = sample.data || peekBytesFromFile(mp4boxfile, sample.offset, sample.size);
        if (sBytes) scanAv2Obus(sBytes);
      }
    }

    var pairKeys = Object.keys(pairMap);
    if (pairKeys.length === 0) {
      addPair(0, 0);
      pairKeys = Object.keys(pairMap);
    }
    var pairs = pairKeys.map(function (k) {
      return pairMap[k];
    });
    pairs.sort(function (a, b) {
      return a.x - b.x || a.m - b.m;
    });
    for (i = 0; i < pairs.length; i++) {
      layers.push({
        id: i,
        x: pairs[i].x,
        m: pairs[i].m,
        label: 'Layer #' + i + ' (x=' + pairs[i].x + ', m=' + pairs[i].m + ')',
      });
    }
  }

  // Also check lpma on any sample entry for layer IDs
  for (i = 0; i < entries.length; i++) {
    se = entries[i];
    var lpmaBox = se.lpma;
    if (!lpmaBox && se.boxes) {
      for (j = 0; j < se.boxes.length; j++) {
        if (se.boxes[j].type === 'lpma') {
          lpmaBox = se.boxes[j];
          break;
        }
      }
    }
    var lpma = parseLpmaFallback(lpmaBox);
    if (lpma && lpma.entries && lpma.entries.length > 0) {
      var targetType = lpma.flags & 1;
      if (!isAv2 && layers.length === 0) {
        layers.push({ id: 0, label: 'Layer #0' });
      }
      if (targetType === 0) {
        for (j = 0; j < lpma.entries.length; j++) {
          var tid = lpma.entries[j].target_id;
          var exists = false;
          for (var li = 0; li < layers.length; li++) {
            if (layers[li].id === tid) {
              exists = true;
              break;
            }
          }
          if (!exists) {
            layers.push({ id: tid, label: 'Layer #' + tid });
          }
        }
      }
    }
  }

  // Also check 'sap ' sample groups for layer IDs
  var sbgps =
    (trak.mdia &&
      trak.mdia.minf &&
      trak.mdia.minf.stbl &&
      trak.mdia.minf.stbl.sbgps) ||
    [];
  for (i = 0; i < sbgps.length; i++) {
    var sbgp = sbgps[i];
    if (sbgp.grouping_type === 'sap ' && sbgp.grouping_type_parameter) {
      var sapMethod = sbgp.grouping_type_parameter & 0xf;
      var sapTarget = (sbgp.grouping_type_parameter >>> 4) & 0x0fffffff;
      var sapLayerIds = [];
      if (sapMethod === 1) {
        sapLayerIds.push(0, sapTarget);
      } else if (sapMethod === 2) {
        for (j = 0; j < 28; j++) {
          if ((sapTarget >>> j) & 1) sapLayerIds.push(j);
        }
      }
      for (j = 0; j < sapLayerIds.length; j++) {
        var slid = sapLayerIds[j];
        var sExists = false;
        for (var sli = 0; sli < layers.length; sli++) {
          if (layers[sli].id === slid) {
            sExists = true;
            break;
          }
        }
        if (!sExists) {
          layers.push({ id: slid, label: 'Layer #' + slid });
        }
      }
    }
  }

  layers.sort(function (a, b) {
    return a.id - b.id;
  });
  return { isAv2: isAv2, layers: layers };
}

function attachAssociationHover(svg) {
  var nodes = svg.selectAll('.assoc-node');
  var arrows = svg.selectAll('.assoc-edge');

  nodes
    .on('mouseenter', function () {
      var nodeId = d3.select(this).attr('data-node-id');
      if (!nodeId) return;
      var connectedNodes = {};
      connectedNodes[nodeId] = true;
      arrows.each(function () {
        var edge = d3.select(this);
        var fromId = edge.attr('data-from');
        var toId = edge.attr('data-to');
        var parentFrom = edge.attr('data-parent-from');
        var parentTo = edge.attr('data-parent-to');
        var match =
          fromId === nodeId ||
          toId === nodeId ||
          parentFrom === nodeId ||
          parentTo === nodeId;
        if (match) {
          connectedNodes[fromId] = true;
          connectedNodes[toId] = true;
          if (parentFrom) connectedNodes[parentFrom] = true;
          if (parentTo) connectedNodes[parentTo] = true;
          edge.style('opacity', 1).select('path').style('stroke-width', '2.8px');
        } else {
          edge.style('opacity', 0.18);
        }
      });
      nodes.each(function () {
        var n = d3.select(this);
        var nid = n.attr('data-node-id');
        n.style('opacity', connectedNodes[nid] ? 1 : 0.45);
      });
    })
    .on('mouseleave', function () {
      arrows.style('opacity', 1).select('path').style('stroke-width', function () {
        return d3.select(this).attr('data-default-width') || '1.6px';
      });
      nodes.style('opacity', 1);
    });

  arrows
    .on('mouseenter', function () {
      var activeEdge = this;
      var edgeSel = d3.select(this);
      var fromId = edgeSel.attr('data-from');
      var toId = edgeSel.attr('data-to');
      arrows.each(function () {
        if (this === activeEdge) {
          d3.select(this).style('opacity', 1).select('path').style('stroke-width', '2.8px');
        } else {
          d3.select(this).style('opacity', 0.18);
        }
      });
      nodes.each(function () {
        var n = d3.select(this);
        var nid = n.attr('data-node-id');
        n.style('opacity', nid === fromId || nid === toId ? 1 : 0.45);
      });
    })
    .on('mouseleave', function () {
      arrows.style('opacity', 1).select('path').style('stroke-width', function () {
        return d3.select(this).attr('data-default-width') || '1.6px';
      });
      nodes.style('opacity', 1);
    });
}

var ASSOC_BOX_COLORS = [
  '#2b6cb0',
  '#c53030',
  '#2f855a',
  '#b7791f',
  '#6b46c1',
  '#00838f',
  '#d53f8c',
  '#dd6b20',
  '#2c5282',
  '#822727',
  '#285e61',
  '#744210',
];

function selectBoxInTreeView(targetBox, fallbackBox) {
  if ((!targetBox && !fallbackBox) || !file || !file.fancytree) return;

  var boxViewIndex = $('#resulttabs > ul > li > a[href="#boxview"]').parent().index();
  $('#resulttabs').tabs('option', 'active', boxViewIndex >= 0 ? boxViewIndex : 1);
  var treeViewIndex = $('#boxview > ul > li > a[href="#boxtreeview"]').parent().index();
  $('#boxview').tabs('option', 'active', treeViewIndex >= 0 ? treeViewIndex : 0);

  function findNodeForBox(box) {
    if (!box) return null;
    var matched = null;
    file.fancytree.visit(function (node) {
      if (node.data && node.data.box === box) {
        matched = node;
        return false;
      }
    });
    if (!matched && box.start !== undefined && box.type) {
      file.fancytree.visit(function (node) {
        if (
          node.data &&
          node.data.box &&
          node.data.box.start === box.start &&
          node.data.box.type === box.type
        ) {
          matched = node;
          return false;
        }
      });
    }
    return matched;
  }

  var targetNode = findNodeForBox(targetBox) || findNodeForBox(fallbackBox);
  if (!targetNode) return;

  var parents = targetNode.getParentList(false, false);
  for (var i = 0; i < parents.length; i++) {
    if (!parents[i].isExpanded()) {
      parents[i].setExpanded(true, { noAnimation: true });
    }
  }

  if (targetNode.isActive()) {
    targetNode.setActive(false);
  }
  targetNode.setActive(true);
  if (typeof targetNode.scrollIntoView === 'function') {
    targetNode.scrollIntoView(false);
  }
}

function buildTracksAssociationSvg(container, mp4boxfile) {
  var traks = (mp4boxfile.moov && mp4boxfile.moov.traks) || [];
  if (traks.length === 0) return;

  var trackModels = [];
  var hasTref = false;
  var i, j, k;

  for (i = 0; i < traks.length; i++) {
    var trak = traks[i];
    var trackId = trak.tkhd ? trak.tkhd.track_id : i + 1;
    var handler = trak.mdia && trak.mdia.hdlr ? trak.mdia.hdlr.handler : '';
    var stsdEntries =
      (trak.mdia &&
        trak.mdia.minf &&
        trak.mdia.minf.stbl &&
        trak.mdia.minf.stbl.stsd &&
        trak.mdia.minf.stbl.stsd.entries) ||
      [];
    var detected = detectTrackLayers(mp4boxfile, trak);
    var layers = detected.layers;
    var isAv2 = detected.isAv2;

    var refs = [];
    if (trak.tref && trak.tref.references) {
      for (j = 0; j < trak.tref.references.length; j++) {
        var refBox = trak.tref.references[j];
        var ids = refBox.track_ids || [];
        for (k = 0; k < ids.length; k++) {
          refs.push({ type: refBox.type, toTrackId: ids[k] });
          hasTref = true;
        }
      }
    }

    var seModels = [];
    for (j = 0; j < stsdEntries.length; j++) {
      var se = stsdEntries[j];
      var childBoxes = se.boxes || [];
      var lpcoBox = se.lpco;
      var lpmaBox = se.lpma;
      for (k = 0; k < childBoxes.length; k++) {
        if (childBoxes[k].type === 'lpco' && !lpcoBox) lpcoBox = childBoxes[k];
        if (childBoxes[k].type === 'lpma' && !lpmaBox) lpmaBox = childBoxes[k];
      }
      var lpma = parseLpmaFallback(lpmaBox);
      var lpcoChildren = parseLpcoBoxesFallback(lpcoBox);
      var targetType = lpma ? lpma.flags & 1 : 0;

      function resolveTargetLayerIds(targetId) {
        var matched = [];
        var li;
        if (targetType === 0) {
          for (li = 0; li < layers.length; li++) {
            if (layers[li].id === targetId) matched.push(layers[li].id);
          }
        } else {
          for (li = 0; li < layers.length; li++) {
            if (li < 31 && ((targetId >>> li) & 1) === 1) {
              matched.push(layers[li].id);
            }
          }
          if (matched.length === 0) {
            for (li = 0; li < layers.length; li++) matched.push(layers[li].id);
          }
        }
        return matched;
      }

      var directBoxes = [];
      for (k = 0; k < childBoxes.length; k++) {
        var cb = childBoxes[k];
        if (!cb || cb.type === 'lpco' || cb.type === 'lpma' || cb.type === 'free' || cb.type === 'skip') {
          continue;
        }
        var targetLayerIds = [];
        function addTargetLayerId(lid) {
          if (targetLayerIds.indexOf(lid) === -1) targetLayerIds.push(lid);
        }
        if (layers.length > 0) {
          if (cb.type === 'av2C' || cb.type === 'av2c' || cb.type === 'lhvC' || cb.type === 'lvcC') {
            for (var li1 = 0; li1 < layers.length; li1++) addTargetLayerId(layers[li1].id);
          } else if (isAv2) {
            for (var li2 = 0; li2 < layers.length; li2++) {
              if (layers[li2].x === 0) addTargetLayerId(layers[li2].id);
            }
            if (targetLayerIds.length === 0) addTargetLayerId(layers[0].id);
          } else {
            addTargetLayerId(layers[0].id);
          }
          if (lpma && lpma.entries) {
            for (var ei = 0; ei < lpma.entries.length; ei++) {
              var ent = lpma.entries[ei];
              var assocs = ent.associations || [];
              for (var ai = 0; ai < assocs.length; ai++) {
                if (assocs[ai].source === 1 && assocs[ai].property_4cc === cb.type) {
                  var rIds = resolveTargetLayerIds(ent.target_id);
                  for (var ri = 0; ri < rIds.length; ri++) addTargetLayerId(rIds[ri]);
                }
              }
            }
          }
        }
        directBoxes.push({
          type: cb.type,
          label: cb.type,
          isLpco: false,
          targetLayerIds: targetLayerIds,
          box: cb,
          fallbackBox: se,
        });
      }

      var lpcoPropBoxes = [];
      for (k = 0; k < lpcoChildren.length; k++) {
        var pb = lpcoChildren[k];
        if (!pb || pb.type === 'free' || pb.type === 'skip') continue;
        var propIdx1 = k + 1;
        var pTargetIds = [];
        function addPTargetId(lid) {
          if (pTargetIds.indexOf(lid) === -1) pTargetIds.push(lid);
        }
        if (lpma && lpma.entries) {
          for (var ei2 = 0; ei2 < lpma.entries.length; ei2++) {
            var ent2 = lpma.entries[ei2];
            var assocs2 = ent2.associations || [];
            for (var ai2 = 0; ai2 < assocs2.length; ai2++) {
              if (
                assocs2[ai2].source === 0 &&
                (assocs2[ai2].property_index === 0 || assocs2[ai2].property_index === propIdx1)
              ) {
                var rIds2 = resolveTargetLayerIds(ent2.target_id);
                for (var ri2 = 0; ri2 < rIds2.length; ri2++) addPTargetId(rIds2[ri2]);
              }
            }
          }
        }
        lpcoPropBoxes.push({
          type: pb.type,
          propIndex: propIdx1,
          label: '#' + propIdx1 + ': ' + pb.type,
          isLpco: true,
          targetLayerIds: pTargetIds,
          box: pb,
          fallbackBox: lpcoBox || se,
        });
      }

      if (directBoxes.length === 0 && lpcoPropBoxes.length === 0) {
        directBoxes.push({
          type: se.type,
          label: se.type,
          isLpco: false,
          targetLayerIds: layers.length > 0 ? [layers[0].id] : [],
          box: se,
          fallbackBox: null,
        });
      }

      seModels.push({
        type: se.type,
        box: se,
        lpcoBox: lpcoBox,
        directBoxes: directBoxes,
        lpcoPropBoxes: lpcoPropBoxes,
      });
    }

    trackModels.push({
      trackId: trackId,
      handler: handler,
      layers: layers,
      refs: refs,
      seModels: seModels,
    });
  }

  var sectionDiv = container.append('div').style('margin-bottom', '20px');
  sectionDiv
    .append('div')
    .style('font-weight', 'bold')
    .style('margin', '8px 0 6px 0')
    .text('Track(s)');

  var leftMargin = hasTref ? 120 : 30;
  var trackColX = leftMargin;
  var trackColW = 250;
  var gapW = 220;
  var boxColX = trackColX + trackColW + gapW;
  var boxColW = 250;
  var totalW = boxColX + boxColW + 30;

  var headerH = 34;
  var rowGap = 22;
  var layerBoxH = 26;
  var layerGap = 7;
  var rightBoxH = 26;
  var rightBoxGap = 7;

  var curY = headerH + 10;
  var trackGeomById = {};
  var edges = [];
  var boxColorIdx = 0;

  for (i = 0; i < trackModels.length; i++) {
    var tm = trackModels[i];
    var trackNodeId = 'track-' + tm.trackId;
    var leftH =
      tm.layers.length > 0
        ? 34 + 10 + tm.layers.length * layerBoxH + (tm.layers.length - 1) * layerGap + 12
        : 42;

    var rightH = 0;
    for (j = 0; j < tm.seModels.length; j++) {
      var sem = tm.seModels[j];
      var seH = 30 + 8;
      if (sem.directBoxes.length > 0) {
        seH += sem.directBoxes.length * rightBoxH + (sem.directBoxes.length - 1) * rightBoxGap + 8;
      }
      if (sem.lpcoPropBoxes.length > 0) {
        seH +=
          26 +
          8 +
          sem.lpcoPropBoxes.length * rightBoxH +
          (sem.lpcoPropBoxes.length - 1) * rightBoxGap +
          10;
      }
      rightH += seH + (j < tm.seModels.length - 1 ? 12 : 0);
    }
    if (rightH === 0) rightH = 42;

    var rowH = Math.max(leftH, rightH);
    tm.x = trackColX;
    tm.y = curY;
    tm.w = trackColW;
    tm.h = leftH;
    tm.cy = curY + leftH / 2;
    tm.nodeId = trackNodeId;

    var layerGeomById = {};
    for (j = 0; j < tm.layers.length; j++) {
      var ly = tm.layers[j];
      ly.x = trackColX + 14;
      ly.y = curY + 34 + 8 + j * (layerBoxH + layerGap);
      ly.w = trackColW - 28;
      ly.h = layerBoxH;
      ly.cy = ly.y + layerBoxH / 2;
      ly.nodeId = trackNodeId + '-layer-' + ly.id;
      layerGeomById[ly.id] = ly;
    }
    tm.layerGeomById = layerGeomById;
    trackGeomById[tm.trackId] = tm;

    var rCurY = curY;
    for (j = 0; j < tm.seModels.length; j++) {
      var sem2 = tm.seModels[j];
      sem2.x = boxColX;
      sem2.y = rCurY;
      sem2.w = boxColW;
      var innerY = rCurY + 30 + 6;
      for (k = 0; k < sem2.directBoxes.length; k++) {
        var db = sem2.directBoxes[k];
        db.x = boxColX + 12;
        db.y = innerY;
        db.w = boxColW - 24;
        db.h = rightBoxH;
        db.cy = db.y + rightBoxH / 2;
        db.nodeId = trackNodeId + '-se-' + j + '-box-' + k;
        db.colorIdx = boxColorIdx % ASSOC_BOX_COLORS.length;
        db.color = ASSOC_BOX_COLORS[db.colorIdx];
        boxColorIdx++;
        innerY += rightBoxH + rightBoxGap;

        if (tm.layers.length === 0) {
          edges.push({
            fromId: db.nodeId,
            toId: tm.nodeId,
            parentFrom: trackNodeId,
            parentTo: trackNodeId,
            x1: db.x,
            y1: db.cy,
            x2: tm.x + tm.w,
            y2: tm.cy,
            color: db.color,
            colorIdx: db.colorIdx,
            title: db.label + ' -> Track #' + tm.trackId,
          });
        } else {
          for (var ti = 0; ti < db.targetLayerIds.length; ti++) {
            var targetLayer = layerGeomById[db.targetLayerIds[ti]];
            if (targetLayer) {
              edges.push({
                fromId: db.nodeId,
                toId: targetLayer.nodeId,
                parentFrom: trackNodeId,
                parentTo: trackNodeId,
                x1: db.x,
                y1: db.cy,
                x2: targetLayer.x + targetLayer.w,
                y2: targetLayer.cy,
                color: db.color,
                colorIdx: db.colorIdx,
                title: db.label + ' -> ' + targetLayer.label,
              });
            }
          }
        }
      }
      if (sem2.lpcoPropBoxes.length > 0) {
        sem2.lpcoX = boxColX + 10;
        sem2.lpcoY = innerY + 2;
        sem2.lpcoW = boxColW - 20;
        innerY = sem2.lpcoY + 26 + 6;
        for (k = 0; k < sem2.lpcoPropBoxes.length; k++) {
          var lpb = sem2.lpcoPropBoxes[k];
          lpb.x = boxColX + 20;
          lpb.y = innerY;
          lpb.w = boxColW - 40;
          lpb.h = rightBoxH;
          lpb.cy = lpb.y + rightBoxH / 2;
          lpb.nodeId = trackNodeId + '-se-' + j + '-lpco-' + k;
          lpb.colorIdx = boxColorIdx % ASSOC_BOX_COLORS.length;
          lpb.color = ASSOC_BOX_COLORS[lpb.colorIdx];
          boxColorIdx++;
          innerY += rightBoxH + rightBoxGap;

          for (var ti2 = 0; ti2 < lpb.targetLayerIds.length; ti2++) {
            var targetLayer2 = layerGeomById[lpb.targetLayerIds[ti2]];
            if (targetLayer2) {
              edges.push({
                fromId: lpb.nodeId,
                toId: targetLayer2.nodeId,
                parentFrom: trackNodeId,
                parentTo: trackNodeId,
                x1: lpb.x,
                y1: lpb.cy,
                x2: targetLayer2.x + targetLayer2.w,
                y2: targetLayer2.cy,
                color: lpb.color,
                colorIdx: lpb.colorIdx,
                title: 'lpco ' + lpb.label + ' -> ' + targetLayer2.label,
              });
            }
          }
        }
        sem2.lpcoH = innerY - sem2.lpcoY - rightBoxGap + 8;
        innerY = sem2.lpcoY + sem2.lpcoH + 8;
      }
      sem2.h = innerY - rCurY - (sem2.lpcoPropBoxes.length > 0 ? 0 : rightBoxGap) + 6;
      rCurY = sem2.y + sem2.h + 12;
    }

    curY += rowH + rowGap;
  }

  var totalH = curY + 10;
  var svg = sectionDiv
    .append('svg')
    .attr('width', totalW)
    .attr('height', totalH)
    .style('max-width', '100%')
    .style('height', 'auto')
    .style('display', 'block')
    .attr('viewBox', '0 0 ' + totalW + ' ' + totalH);

  var defs = svg.append('defs');
  for (var ci = 0; ci < ASSOC_BOX_COLORS.length; ci++) {
    defs
      .append('marker')
      .attr('id', 'assoc-arrow-tracks-' + ci)
      .attr('markerWidth', 10)
      .attr('markerHeight', 10)
      .attr('refX', 9)
      .attr('refY', 5)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,1 L9,5 L0,9 z')
      .attr('fill', ASSOC_BOX_COLORS[ci]);
  }
  defs
    .append('marker')
    .attr('id', 'ref-arrow-tracks')
    .attr('markerWidth', 10)
    .attr('markerHeight', 10)
    .attr('refX', 9)
    .attr('refY', 5)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,1 L9,5 L0,9 z')
    .attr('fill', '#805ad5');

  svg
    .append('text')
    .attr('x', trackColX + trackColW / 2)
    .attr('y', 22)
    .attr('text-anchor', 'middle')
    .style('font-weight', 'bold')
    .style('font-size', '13px')
    .text('Tracks & Layers');
  svg
    .append('text')
    .attr('x', boxColX + boxColW / 2)
    .attr('y', 22)
    .attr('text-anchor', 'middle')
    .style('font-weight', 'bold')
    .style('font-size', '13px')
    .text('Sample Entry Boxes');

  for (i = 0; i < trackModels.length; i++) {
    var tmDraw = trackModels[i];
    var tg = svg
      .append('g')
      .attr('class', 'assoc-node')
      .attr('data-node-id', tmDraw.nodeId);
    tg.append('rect')
      .attr('x', tmDraw.x)
      .attr('y', tmDraw.y)
      .attr('width', tmDraw.w)
      .attr('height', tmDraw.h)
      .attr('rx', 6)
      .attr('ry', 6)
      .style('fill', '#ebf4ff')
      .style('stroke', '#3182ce')
      .style('stroke-width', '1.5px');
    tg.append('text')
      .attr('x', tmDraw.x + tmDraw.w / 2)
      .attr('y', tmDraw.layers.length > 0 ? tmDraw.y + 20 : tmDraw.cy)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .style('font-weight', 'bold')
      .style('font-size', '12px')
      .style('fill', '#1a365d')
      .text(
        'Track #' +
          tmDraw.trackId +
          (tmDraw.handler ? ' (' + tmDraw.handler + ')' : ''),
      );

    for (j = 0; j < tmDraw.layers.length; j++) {
      var lyDraw = tmDraw.layers[j];
      var lg = svg
        .append('g')
        .attr('class', 'assoc-node')
        .attr('data-node-id', lyDraw.nodeId);
      lg.append('rect')
        .attr('x', lyDraw.x)
        .attr('y', lyDraw.y)
        .attr('width', lyDraw.w)
        .attr('height', lyDraw.h)
        .attr('rx', 4)
        .attr('ry', 4)
        .style('fill', '#ffffff')
        .style('stroke', '#2b6cb0')
        .style('stroke-width', '1.2px');
      lg.append('text')
        .attr('x', lyDraw.x + lyDraw.w / 2)
        .attr('y', lyDraw.cy)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .style('font-size', '11px')
        .style('fill', '#2c5282')
        .text(lyDraw.label);
    }

    for (j = 0; j < tmDraw.seModels.length; j++) {
      var semDraw = tmDraw.seModels[j];
      var seg = svg
        .append('g')
        .style('cursor', 'pointer')
        .on(
          'click',
          (function (b) {
            return function () {
              selectBoxInTreeView(b, null);
            };
          })(semDraw.box),
        );
      seg
        .append('rect')
        .attr('x', semDraw.x)
        .attr('y', semDraw.y)
        .attr('width', semDraw.w)
        .attr('height', semDraw.h)
        .attr('rx', 6)
        .attr('ry', 6)
        .style('fill', '#f7fafc')
        .style('stroke', '#a0aec0')
        .style('stroke-width', '1.2px');
      seg
        .append('text')
        .attr('x', semDraw.x + semDraw.w / 2)
        .attr('y', semDraw.y + 16)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .style('font-weight', 'bold')
        .style('font-size', '12px')
        .style('fill', '#2d3748')
        .text('Sample Entry (' + semDraw.type + ')');

      for (k = 0; k < semDraw.directBoxes.length; k++) {
        var dbDraw = semDraw.directBoxes[k];
        var dbg = svg
          .append('g')
          .attr('class', 'assoc-node')
          .attr('data-node-id', dbDraw.nodeId)
          .style('cursor', 'pointer')
          .on(
            'click',
            (function (b, fb) {
              return function () {
                if (d3.event) d3.event.stopPropagation();
                selectBoxInTreeView(b, fb);
              };
            })(dbDraw.box, dbDraw.fallbackBox),
          );
        dbg
          .append('rect')
          .attr('x', dbDraw.x)
          .attr('y', dbDraw.y)
          .attr('width', dbDraw.w)
          .attr('height', dbDraw.h)
          .attr('rx', 4)
          .attr('ry', 4)
          .style('fill', '#edf2f7')
          .style('stroke', dbDraw.color)
          .style('stroke-width', '1.5px');
        dbg
          .append('text')
          .attr('x', dbDraw.x + dbDraw.w / 2)
          .attr('y', dbDraw.cy)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .style('font-family', 'monospace')
          .style('font-size', '12px')
          .style('fill', '#1a202c')
          .text(dbDraw.label);
      }

      if (semDraw.lpcoPropBoxes.length > 0) {
        var lpcog = svg
          .append('g')
          .style('cursor', 'pointer')
          .on(
            'click',
            (function (b, fb) {
              return function () {
                if (d3.event) d3.event.stopPropagation();
                selectBoxInTreeView(b, fb);
              };
            })(semDraw.lpcoBox, semDraw.box),
          );
        lpcog
          .append('rect')
          .attr('x', semDraw.lpcoX)
          .attr('y', semDraw.lpcoY)
          .attr('width', semDraw.lpcoW)
          .attr('height', semDraw.lpcoH)
          .attr('rx', 5)
          .attr('ry', 5)
          .style('fill', '#fffaf0')
          .style('stroke', '#dd6b20')
          .style('stroke-dasharray', '4,2')
          .style('stroke-width', '1.2px');
        lpcog
          .append('text')
          .attr('x', semDraw.lpcoX + semDraw.lpcoW / 2)
          .attr('y', semDraw.lpcoY + 14)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .style('font-weight', 'bold')
          .style('font-size', '11px')
          .style('fill', '#9c4221')
          .text('lpco');

        for (k = 0; k < semDraw.lpcoPropBoxes.length; k++) {
          var lpbDraw = semDraw.lpcoPropBoxes[k];
          var lpbg = svg
            .append('g')
            .attr('class', 'assoc-node')
            .attr('data-node-id', lpbDraw.nodeId)
            .style('cursor', 'pointer')
            .on(
              'click',
              (function (b, fb) {
                return function () {
                  if (d3.event) d3.event.stopPropagation();
                  selectBoxInTreeView(b, fb);
                };
              })(lpbDraw.box, lpbDraw.fallbackBox),
            );
          lpbg
            .append('rect')
            .attr('x', lpbDraw.x)
            .attr('y', lpbDraw.y)
            .attr('width', lpbDraw.w)
            .attr('height', lpbDraw.h)
            .attr('rx', 4)
            .attr('ry', 4)
            .style('fill', '#feebc8')
            .style('stroke', lpbDraw.color)
            .style('stroke-width', '1.5px');
          lpbg
            .append('text')
            .attr('x', lpbDraw.x + lpbDraw.w / 2)
            .attr('y', lpbDraw.cy)
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'central')
            .style('font-family', 'monospace')
            .style('font-size', '11px')
            .style('fill', '#744210')
            .text(lpbDraw.label);
        }
      }
    }
  }

  // Draw Sample Entry Box -> Track/Layer edges
  for (i = 0; i < edges.length; i++) {
    var e = edges[i];
    var dx = e.x1 - e.x2;
    var pathD =
      'M' +
      e.x1 +
      ',' +
      e.y1 +
      ' C' +
      (e.x1 - dx * 0.45) +
      ',' +
      e.y1 +
      ' ' +
      (e.x2 + dx * 0.45) +
      ',' +
      e.y2 +
      ' ' +
      e.x2 +
      ',' +
      e.y2;
    var markerId = 'url(#assoc-arrow-tracks-' + e.colorIdx + ')';
    var eg = svg
      .append('g')
      .attr('class', 'assoc-edge')
      .attr('data-from', e.fromId)
      .attr('data-to', e.toId)
      .attr('data-parent-from', e.parentFrom)
      .attr('data-parent-to', e.parentTo);
    eg.append('title').text(e.title);
    eg.append('path')
      .attr('d', pathD)
      .attr('fill', 'none')
      .attr('data-default-width', '1.6px')
      .style('stroke', e.color)
      .style('stroke-width', '1.6px')
      .attr('marker-end', markerId);
  }

  // Draw Track Reference (tref) arrows on the left
  var refIdx = 0;
  for (i = 0; i < trackModels.length; i++) {
    var srcTm = trackModels[i];
    for (j = 0; j < srcTm.refs.length; j++) {
      var ref = srcTm.refs[j];
      var dstTm = trackGeomById[ref.toTrackId];
      if (!dstTm) continue;
      var sx = srcTm.x;
      var sy = srcTm.cy < dstTm.cy ? srcTm.cy + 4 : srcTm.cy - 4;
      var tx = dstTm.x;
      var ty = srcTm.cy < dstTm.cy ? dstTm.cy - 4 : dstTm.cy + 4;
      var arcX = Math.max(12, sx - 42 - (refIdx % 3) * 24);
      var refPath = 'M' + sx + ',' + sy + ' C' + arcX + ',' + sy + ' ' + arcX + ',' + ty + ' ' + tx + ',' + ty;
      var rg = svg
        .append('g')
        .attr('class', 'assoc-edge')
        .attr('data-from', srcTm.nodeId)
        .attr('data-to', dstTm.nodeId)
        .attr('data-parent-from', srcTm.nodeId)
        .attr('data-parent-to', dstTm.nodeId);
      rg.append('title').text(
        'Track #' + srcTm.trackId + ' --[' + ref.type + ']--> Track #' + dstTm.trackId,
      );
      rg.append('path')
        .attr('d', refPath)
        .attr('fill', 'none')
        .attr('data-default-width', '1.8px')
        .style('stroke', '#805ad5')
        .style('stroke-width', '1.8px')
        .attr('marker-end', 'url(#ref-arrow-tracks)');
      var lx = 0.25 * sx + 0.75 * arcX;
      var lyMid = (sy + ty) / 2;
      rg.append('rect')
        .attr('x', lx - 18)
        .attr('y', lyMid - 9)
        .attr('width', 36)
        .attr('height', 18)
        .attr('rx', 3)
        .attr('ry', 3)
        .style('fill', '#faf5ff')
        .style('stroke', '#805ad5')
        .style('stroke-width', '1px');
      rg.append('text')
        .attr('x', lx)
        .attr('y', lyMid)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .style('font-family', 'monospace')
        .style('font-size', '10px')
        .style('fill', '#553c9a')
        .text(ref.type);
      refIdx++;
    }
  }

  attachAssociationHover(svg);
}

function buildItemsAssociationSvg(container, mp4boxfile) {
  var rawItems = mp4boxfile.items;
  if (!rawItems) return;
  var itemList = [];
  for (var itemId in rawItems) {
    if (Object.prototype.hasOwnProperty.call(rawItems, itemId) && rawItems[itemId]) {
      itemList.push(rawItems[itemId]);
    }
  }
  if (itemList.length === 0) return;
  itemList.sort(function (a, b) {
    return a.id - b.id;
  });

  var hasIref = false;
  var i, j, k;
  var itemModels = [];
  var itemModelById = {};

  for (i = 0; i < itemList.length; i++) {
    var it = itemList[i];
    var selectedLayer = null;
    if (it.properties && it.properties.boxes) {
      for (j = 0; j < it.properties.boxes.length; j++) {
        var pb = it.properties.boxes[j];
        if (pb.type === 'lsel' && pb.layer_id !== undefined) {
          selectedLayer = 'Layer #' + pb.layer_id + ' (lsel)';
          break;
        } else if (pb.type === 'a1op' && pb.op_index !== undefined) {
          selectedLayer = 'Layer #' + pb.op_index + ' (a1op)';
          break;
        }
      }
    }
    if (it.ref_to && it.ref_to.length > 0) {
      hasIref = true;
    }
    var im = {
      id: it.id,
      name: it.name,
      type: it.type === 'mime' ? it.content_type : it.type,
      primary: !!it.primary,
      selectedLayer: selectedLayer,
      ref_to: it.ref_to || [],
      rawItem: it,
    };
    itemModels.push(im);
    itemModelById[it.id] = im;
  }

  var ipcoBoxes =
    (mp4boxfile.meta &&
      mp4boxfile.meta.iprp &&
      mp4boxfile.meta.iprp.ipco &&
      mp4boxfile.meta.iprp.ipco.boxes) ||
    [];
  var ipmas =
    (mp4boxfile.meta && mp4boxfile.meta.iprp && mp4boxfile.meta.iprp.ipmas) || [];

  var propModels = [];
  if (ipcoBoxes.length > 0) {
    for (i = 0; i < ipcoBoxes.length; i++) {
      var propBox = ipcoBoxes[i];
      if (!propBox) continue;
      var propIdx1 = i + 1;
      var targetItemIds = [];
      function addTargetItemId(tid) {
        if (targetItemIds.indexOf(tid) === -1) targetItemIds.push(tid);
      }
      for (j = 0; j < ipmas.length; j++) {
        var assocs = ipmas[j].associations || [];
        for (k = 0; k < assocs.length; k++) {
          var assoc = assocs[k];
          if (!itemModelById[assoc.id]) continue;
          var props = assoc.props || [];
          for (var pi = 0; pi < props.length; pi++) {
            if (props[pi].property_index === propIdx1) {
              addTargetItemId(assoc.id);
            }
          }
        }
      }
      if (targetItemIds.length === 0) {
        for (j = 0; j < itemModels.length; j++) {
          var rIt = itemModels[j].rawItem;
          if (rIt.properties && rIt.properties.boxes && rIt.properties.boxes.indexOf(propBox) !== -1) {
            addTargetItemId(rIt.id);
          }
        }
      }
      propModels.push({
        propIndex: propIdx1,
        type: propBox.type,
        label: '#' + propIdx1 + ': ' + propBox.type,
        targetItemIds: targetItemIds,
        box: propBox,
      });
    }
  } else {
    // Fallback if ipco is not directly on meta.iprp
    var seenBoxes = [];
    for (i = 0; i < itemModels.length; i++) {
      var rIt2 = itemModels[i].rawItem;
      var pbs = (rIt2.properties && rIt2.properties.boxes) || [];
      for (j = 0; j < pbs.length; j++) {
        var idx = seenBoxes.indexOf(pbs[j]);
        if (idx === -1) {
          idx = seenBoxes.length;
          seenBoxes.push(pbs[j]);
          propModels.push({
            propIndex: idx + 1,
            type: pbs[j].type,
            label: '#' + (idx + 1) + ': ' + pbs[j].type,
            targetItemIds: [rIt2.id],
            box: pbs[j],
          });
        } else if (propModels[idx].targetItemIds.indexOf(rIt2.id) === -1) {
          propModels[idx].targetItemIds.push(rIt2.id);
        }
      }
    }
  }

  var sectionDiv = container.append('div').style('margin-bottom', '20px');
  sectionDiv
    .append('div')
    .style('font-weight', 'bold')
    .style('margin', '8px 0 6px 0')
    .text('Item(s)');

  var leftMargin = hasIref ? 120 : 30;
  var itemColX = leftMargin;
  var itemColW = 250;
  var gapW = 220;
  var propColX = itemColX + itemColW + gapW;
  var propColW = 250;
  var totalW = propColX + propColW + 30;

  var headerH = 34;
  var itemGap = 12;
  var propBoxH = 28;
  var propGap = 8;

  var leftY = headerH + 10;
  for (i = 0; i < itemModels.length; i++) {
    var imGeom = itemModels[i];
    imGeom.x = itemColX;
    imGeom.y = leftY;
    imGeom.w = itemColW;
    imGeom.h = imGeom.selectedLayer ? 66 : 34;
    imGeom.cy = imGeom.y + imGeom.h / 2;
    imGeom.nodeId = 'item-' + imGeom.id;
    if (imGeom.selectedLayer) {
      imGeom.layerX = itemColX + 14;
      imGeom.layerY = imGeom.y + 32;
      imGeom.layerW = itemColW - 28;
      imGeom.layerH = 24;
      imGeom.layerCy = imGeom.layerY + 12;
    }
    leftY += imGeom.h + itemGap;
  }

  var rightY = headerH + 10;
  var ipcoContainerX = propColX;
  var ipcoContainerY = rightY;
  var ipcoContainerW = propColW;
  var propInnerY = ipcoContainerY + 30 + 6;
  for (i = 0; i < propModels.length; i++) {
    var pmGeom = propModels[i];
    pmGeom.x = propColX + 12;
    pmGeom.y = propInnerY;
    pmGeom.w = propColW - 24;
    pmGeom.h = propBoxH;
    pmGeom.cy = pmGeom.y + propBoxH / 2;
    pmGeom.nodeId = 'prop-' + pmGeom.propIndex;
    propInnerY += propBoxH + propGap;
  }
  var ipcoContainerH =
    propModels.length > 0 ? propInnerY - ipcoContainerY - propGap + 10 : 40;
  rightY = ipcoContainerY + ipcoContainerH + 10;

  var totalH = Math.max(leftY, rightY) + 10;
  var svg = sectionDiv
    .append('svg')
    .attr('width', totalW)
    .attr('height', totalH)
    .style('max-width', '100%')
    .style('height', 'auto')
    .style('display', 'block')
    .attr('viewBox', '0 0 ' + totalW + ' ' + totalH);

  var defs = svg.append('defs');
  for (var pci = 0; pci < ASSOC_BOX_COLORS.length; pci++) {
    defs
      .append('marker')
      .attr('id', 'assoc-arrow-items-' + pci)
      .attr('markerWidth', 10)
      .attr('markerHeight', 10)
      .attr('refX', 9)
      .attr('refY', 5)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,1 L9,5 L0,9 z')
      .attr('fill', ASSOC_BOX_COLORS[pci]);
  }
  defs
    .append('marker')
    .attr('id', 'ref-arrow-items')
    .attr('markerWidth', 10)
    .attr('markerHeight', 10)
    .attr('refX', 9)
    .attr('refY', 5)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,1 L9,5 L0,9 z')
    .attr('fill', '#805ad5');

  svg
    .append('text')
    .attr('x', itemColX + itemColW / 2)
    .attr('y', 22)
    .attr('text-anchor', 'middle')
    .style('font-weight', 'bold')
    .style('font-size', '13px')
    .text('Items');
  svg
    .append('text')
    .attr('x', propColX + propColW / 2)
    .attr('y', 22)
    .attr('text-anchor', 'middle')
    .style('font-weight', 'bold')
    .style('font-size', '13px')
    .text('Properties');

  for (i = 0; i < itemModels.length; i++) {
    var imDraw = itemModels[i];
    var ig = svg
      .append('g')
      .attr('class', 'assoc-node')
      .attr('data-node-id', imDraw.nodeId);
    ig.append('rect')
      .attr('x', imDraw.x)
      .attr('y', imDraw.y)
      .attr('width', imDraw.w)
      .attr('height', imDraw.h)
      .attr('rx', 6)
      .attr('ry', 6)
      .style('fill', imDraw.primary ? '#e6fffa' : '#ebf4ff')
      .style('stroke', imDraw.primary ? '#2c7a7b' : '#3182ce')
      .style('stroke-width', imDraw.primary ? '2px' : '1.5px');
    var itemTitle =
      'Item #' +
      imDraw.id +
      ' (' +
      imDraw.type +
      ')' +
      (imDraw.primary ? ' [Primary]' : '');
    ig.append('text')
      .attr('x', imDraw.x + imDraw.w / 2)
      .attr('y', imDraw.selectedLayer ? imDraw.y + 18 : imDraw.cy)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .style('font-weight', 'bold')
      .style('font-size', '12px')
      .style('fill', '#1a365d')
      .text(itemTitle);

    if (imDraw.selectedLayer) {
      ig.append('rect')
        .attr('x', imDraw.layerX)
        .attr('y', imDraw.layerY)
        .attr('width', imDraw.layerW)
        .attr('height', imDraw.layerH)
        .attr('rx', 4)
        .attr('ry', 4)
        .style('fill', '#ffffff')
        .style('stroke', '#2b6cb0')
        .style('stroke-width', '1.2px');
      ig.append('text')
        .attr('x', imDraw.layerX + imDraw.layerW / 2)
        .attr('y', imDraw.layerCy)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .style('font-size', '11px')
        .style('fill', '#2c5282')
        .text(imDraw.selectedLayer);
    }
  }

  if (propModels.length > 0) {
    var ipcoBoxObj =
      mp4boxfile.meta && mp4boxfile.meta.iprp && mp4boxfile.meta.iprp.ipco
        ? mp4boxfile.meta.iprp.ipco
        : null;
    var ipcog = svg
      .append('g')
      .style('cursor', ipcoBoxObj ? 'pointer' : 'default')
      .on('click', function () {
        if (ipcoBoxObj) selectBoxInTreeView(ipcoBoxObj, null);
      });
    ipcog
      .append('rect')
      .attr('x', ipcoContainerX)
      .attr('y', ipcoContainerY)
      .attr('width', ipcoContainerW)
      .attr('height', ipcoContainerH)
      .attr('rx', 6)
      .attr('ry', 6)
      .style('fill', '#f7fafc')
      .style('stroke', '#a0aec0')
      .style('stroke-width', '1.2px');
    ipcog
      .append('text')
      .attr('x', ipcoContainerX + ipcoContainerW / 2)
      .attr('y', ipcoContainerY + 16)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .style('font-weight', 'bold')
      .style('font-size', '12px')
      .style('fill', '#2d3748')
      .text('Item Properties (ipco)');

    for (i = 0; i < propModels.length; i++) {
      var pmDraw = propModels[i];
      var pColorIdx = i % ASSOC_BOX_COLORS.length;
      var pColor = ASSOC_BOX_COLORS[pColorIdx];
      var pg = svg
        .append('g')
        .attr('class', 'assoc-node')
        .attr('data-node-id', pmDraw.nodeId)
        .style('cursor', 'pointer')
        .on(
          'click',
          (function (b, fb) {
            return function () {
              if (d3.event) d3.event.stopPropagation();
              selectBoxInTreeView(b, fb);
            };
          })(pmDraw.box, ipcoBoxObj),
        );
      pg.append('rect')
        .attr('x', pmDraw.x)
        .attr('y', pmDraw.y)
        .attr('width', pmDraw.w)
        .attr('height', pmDraw.h)
        .attr('rx', 4)
        .attr('ry', 4)
        .style('fill', '#f0fff4')
        .style('stroke', pColor)
        .style('stroke-width', '1.5px');
      pg.append('text')
        .attr('x', pmDraw.x + pmDraw.w / 2)
        .attr('y', pmDraw.cy)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .style('font-family', 'monospace')
        .style('font-size', '12px')
        .style('fill', '#22543d')
        .text(pmDraw.label);

      for (j = 0; j < pmDraw.targetItemIds.length; j++) {
        var targetItem = itemModelById[pmDraw.targetItemIds[j]];
        if (!targetItem) continue;
        var sx = pmDraw.x;
        var sy = pmDraw.cy;
        var tx = targetItem.x + targetItem.w;
        var ty = targetItem.cy;
        var dx = sx - tx;
        var pathD =
          'M' +
          sx +
          ',' +
          sy +
          ' C' +
          (sx - dx * 0.45) +
          ',' +
          sy +
          ' ' +
          (tx + dx * 0.45) +
          ',' +
          ty +
          ' ' +
          tx +
          ',' +
          ty;
        var eg = svg
          .append('g')
          .attr('class', 'assoc-edge')
          .attr('data-from', pmDraw.nodeId)
          .attr('data-to', targetItem.nodeId)
          .attr('data-parent-from', pmDraw.nodeId)
          .attr('data-parent-to', targetItem.nodeId);
        eg.append('title').text(pmDraw.label + ' -> Item #' + targetItem.id);
        eg.append('path')
          .attr('d', pathD)
          .attr('fill', 'none')
          .attr('data-default-width', '1.6px')
          .style('stroke', pColor)
          .style('stroke-width', '1.6px')
          .attr('marker-end', 'url(#assoc-arrow-items-' + pColorIdx + ')');
      }
    }
  }

  // Draw Item Reference (iref) arrows on the left
  var irefIdx = 0;
  for (i = 0; i < itemModels.length; i++) {
    var srcIm = itemModels[i];
    for (j = 0; j < srcIm.ref_to.length; j++) {
      var ref = srcIm.ref_to[j];
      var dstIm = itemModelById[ref.id];
      if (!dstIm) continue;
      var sx2 = srcIm.x;
      var sy2 = srcIm.cy < dstIm.cy ? srcIm.cy + 4 : srcIm.cy - 4;
      var tx2 = dstIm.x;
      var ty2 = srcIm.cy < dstIm.cy ? dstIm.cy - 4 : dstIm.cy + 4;
      var arcX = Math.max(12, sx2 - 42 - (irefIdx % 3) * 24);
      var refPath =
        'M' + sx2 + ',' + sy2 + ' C' + arcX + ',' + sy2 + ' ' + arcX + ',' + ty2 + ' ' + tx2 + ',' + ty2;
      var rg = svg
        .append('g')
        .attr('class', 'assoc-edge')
        .attr('data-from', srcIm.nodeId)
        .attr('data-to', dstIm.nodeId)
        .attr('data-parent-from', srcIm.nodeId)
        .attr('data-parent-to', dstIm.nodeId);
      rg.append('title').text(
        'Item #' + srcIm.id + ' --[' + ref.type + ']--> Item #' + dstIm.id,
      );
      rg.append('path')
        .attr('d', refPath)
        .attr('fill', 'none')
        .attr('data-default-width', '1.8px')
        .style('stroke', '#805ad5')
        .style('stroke-width', '1.8px')
        .attr('marker-end', 'url(#ref-arrow-items)');
      var lx = 0.25 * sx2 + 0.75 * arcX;
      var lyMid = (sy2 + ty2) / 2;
      rg.append('rect')
        .attr('x', lx - 18)
        .attr('y', lyMid - 9)
        .attr('width', 36)
        .attr('height', 18)
        .attr('rx', 3)
        .attr('ry', 3)
        .style('fill', '#faf5ff')
        .style('stroke', '#805ad5')
        .style('stroke-width', '1px');
      rg.append('text')
        .attr('x', lx)
        .attr('y', lyMid)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .style('font-family', 'monospace')
        .style('font-size', '10px')
        .style('fill', '#553c9a')
        .text(ref.type);
      irefIdx++;
    }
  }

  attachAssociationHover(svg);
}

function buildAssociationView(mp4boxfile) {
  var container = d3.select('#associationview');
  container.html('');
  if (!mp4boxfile) return;
  buildTracksAssociationSvg(container, mp4boxfile);
  buildItemsAssociationSvg(container, mp4boxfile);
}

function buildItemTable(items) {
  var html;
  var i, j;
  html = '<table>';
  html += '<thead>';
  html += '<tr>';
  html += '<th>ID</th>';
  html += '<th>Name</th>';
  html += '<th>Type</th>';
  html += '<th>Primary</th>';
  html += '<th>Protected</th>';
  html += '<th>Byte ranges</th>';
  html += '<th>References [type, item ID]</th>';
  html += '<th>Properties [type]</th>';
  html += '</tr>';
  html += '</thead>';
  html += '<tbody>';
  for (i in items) {
    var item = items[i];
    html += "<tr onclick='displayItemContent(" + item.id + ");'>";
    html += '<td>' + item.id + '</td>';
    html += '<td>' + (item.name ? item.name : '') + '</td>';
    html += '<td>' + (item.type === 'mime' ? item.content_type : item.type) + '</td>';
    html += '<td>' + (item.primary ? 'Yes' : 'No') + '</td>';
    html += '<td>' + (item.protection ? item.protection : 'No') + '</td>';
    html += '<td>';
    for (j = 0; j < (item.extents ? item.extents.length : 0); j++) {
      html +=
        '[' +
        item.extents[j].offset +
        '-' +
        (item.extents[j].offset + item.extents[j].length - 1) +
        '] ';
    }
    html += '</td>';
    html += '<td>';
    if (item.ref_to) {
      for (j = 0; j < item.ref_to.length; j++) {
        html += '[' + item.ref_to[j].type + ', ' + item.ref_to[j].id + '] ';
      }
    }
    html += '</td>';
    html += '<td>';
    if (item.properties) {
      for (j = 0; j < item.properties.boxes.length; j++) {
        html += '' + item.properties.boxes[j].type + ' ';
      }
    }
    html += '</td>';
    html += '</tr>';
  }
  html += '</tbody>';
  html += '</table>';
  $('#itemview').html(html);
}

function resetSampleView() {
  $('#sampletable').html('');
  $('#samplemap').html('');
  $('#trackinfo').val('');
  $('#trackSelect').html('');
  $('#sample-range-value').val('');
  $('#samplegraph').html('');
  $('#sampletimeline').html('');
}

function buildSampleTrackView(info, trackSelector, track_index) {
  var graph;
  var timeline;

  $('#trackinfo').val(info.tracks[track_index].codec);
  var sampleRangeSlider = $('#sample-range');
  var sampleRangeText = $('#sample-range-value');
  sampleRangeSlider.dragslider({
    range: true,
    rangeDrag: true,
    min: 0,
    step: 0.01,
    max: 100,
    values: [
      trackSelector.startSample / info.tracks[track_index].nb_samples,
      trackSelector.endSample / info.tracks[track_index].nb_samples,
    ],
    slide: function (event, ui) {
      trackSelector.startSample = Math.floor(
        (ui.values[0] * info.tracks[track_index].nb_samples) / 100,
      );
      trackSelector.endSample = Math.floor(
        (ui.values[1] * info.tracks[track_index].nb_samples) / 100,
      );

      sampleRangeText.val(
        '' +
          trackSelector.startSample +
          ' - ' +
          trackSelector.endSample +
          '/' +
          info.tracks[track_index].nb_samples,
      );

      if ($('#sampletable').is(':visible')) {
        buildSampleTableInfo(
          info.tracks[track_index].id,
          trackSelector.startSample,
          trackSelector.endSample,
        );
      }

      if ($('#samplegraph').is(':visible')) {
        graph.data = file.mp4boxfile
          .getTrackSamplesInfo(info.tracks[track_index].id)
          .slice(trackSelector.startSample, trackSelector.endSample);
        graph.update();
      }

      if ($('#sampletimeline').is(':visible')) {
        timeline.data = file.mp4boxfile
          .getTrackSamplesInfo(info.tracks[track_index].id)
          .slice(trackSelector.startSample, trackSelector.endSample);
        timeline.update();
      }

      if ($('#samplemap').is(':visible')) {
        buildSampleMap(trackSelector.startSample, trackSelector.endSample);
      }
    },
  });

  sampleRangeText.val(
    '' +
      trackSelector.startSample +
      ' - ' +
      trackSelector.endSample +
      '/' +
      info.tracks[track_index].nb_samples,
  );

  buildSampleTableInfo(
    info.tracks[track_index].id,
    trackSelector.startSample,
    trackSelector.endSample,
  );

  graph = new SampleGraph();
  graph.data = file.mp4boxfile
    .getTrackSamplesInfo(info.tracks[track_index].id)
    .slice(trackSelector.startSample, trackSelector.endSample);
  graph.update();

  timeline = new SampleTimeline();
  timeline.data = file.mp4boxfile
    .getTrackSamplesInfo(info.tracks[track_index].id)
    .slice(trackSelector.startSample, trackSelector.endSample);
  timeline.update();

  buildSampleMap(trackSelector.startSample, trackSelector.endSample);
}

function buildSampleView() {
  var info = file.mp4boxfile.getInfo();
  if (info.tracks) {
    $('#trackinfo').addClass('ui-widget ui-widget-content ui-corner-all');
    $('#sample-range-value').addClass('ui-widget ui-widget-content ui-corner-all');
    var trackSelector = $('#trackSelect');
    trackSelector.selectmenu();
    trackSelector.startSample = 0;
    trackSelector.endSample = 10;
    trackSelector.html('');
    for (i = 0; i < info.tracks.length; i++) {
      trackSelector.append($('<option></option>').attr('value', i).text(info.tracks[i].id));
    }
    trackSelector.selectmenu({
      width: 100,
      change: function (event, data) {
        buildSampleTrackView(info, trackSelector, data.item.value);
      },
    });
    trackSelector.val(info.tracks[0].id);
    trackSelector.selectmenu('refresh');
    buildSampleTrackView(info, trackSelector, 0);
    buildSampleMap(trackSelector.startSample, trackSelector.endSample);
  }
}

function buildSampleTableInfo(track_id, start, end) {
  var html;
  var i, j;
  var samples;
  var properties = [
    'number',
    'dts',
    'cts',
    'offset',
    'size',
    'moof_number',
    'is_sync',
    'is_leading',
    'depends_on',
    'is_depended_on',
    'has_redundancy',
    'degradation_priority',
  ];
  var prop;
  var sample;
  var trak;
  var sample_group_info;
  var sample_group_name;

  function getShowHidePropertyCheckbox(name) {
    var html = '<label>';
    var esc_name = name.replace('/', '_');
    html += name;
    html +=
      "<input name='check_" +
      esc_name +
      "' type='checkbox' checked='checked' value='" +
      esc_name +
      "'";
    html +=
      ' onchange=\'if (!this.checked) { $(".stbl_' +
      esc_name +
      '").hide(); } else { $(".stbl_' +
      esc_name +
      '").show();} \'>';
    html += '</label>';
    return html;
  }

  trak = file.mp4boxfile.getTrackById(track_id);

  html = "<div style='margin-top: 10px;margin-bottom: 10px;'>Show sample properties: ";
  for (prop in properties) {
    html += getShowHidePropertyCheckbox(properties[prop]);
  }
  if (trak.mdia.minf.stbl.subs || trak.has_fragment_subsamples) {
    html += getShowHidePropertyCheckbox('subsamples');
  }
  if (trak && trak.sample_groups_info) {
    html += '<br>';
    html += 'Show sample groups: ';
    for (j in trak.sample_groups_info) {
      sample_group_info = trak.sample_groups_info[j];
      sample_group_name =
        sample_group_info.grouping_type.trim() + '/' + sample_group_info.grouping_type_parameter;
      html += getShowHidePropertyCheckbox(sample_group_name);
    }
  }
  html += '</div>';

  html += '<table>';
  html += '<thead>';
  html += '<tr>';
  for (prop in properties) {
    html += "<th class='stbl_" + properties[prop] + "'>" + properties[prop] + '</th>';
  }
  if (trak && trak.sample_groups_info) {
    //html += "<th>Groups</th>";
    for (j in trak.sample_groups_info) {
      sample_group_info = trak.sample_groups_info[j];
      sample_group_name =
        sample_group_info.grouping_type.trim() + '/' + sample_group_info.grouping_type_parameter;
      html +=
        "<th class='stbl_" +
        sample_group_name.replace('/', '_') +
        "'>Sample Group '" +
        sample_group_name +
        "'</th>";
    }
  }
  if (trak.mdia.minf.stbl.subs || trak.has_fragment_subsamples) {
    html += "<th class='stbl_subsamples'>subsamples</th>";
  }
  html += '</tr>';
  html += '</thead>';
  html += '<tbody>';

  samples = file.mp4boxfile.getTrackSamplesInfo(track_id);
  if (samples.length < end) end = samples.length;
  for (i = start; i < end; i++) {
    sample = samples[i];
    html += '<tr>';
    for (prop in properties) {
      html += "<td class='stbl_" + properties[prop] + "'>" + sample[properties[prop]];
      if (properties[prop] == 'cts' || properties[prop] == 'dts') {
        html += ' - ' + Log.getDurationString(sample[properties[prop]], sample.timescale);
      }
      html += '</td>';
    }
    if (sample.sample_groups) {
      for (j in sample.sample_groups) {
        sample_group_info = sample.sample_groups[j];
        if (sample_group_info) {
          sample_group_name =
            sample_group_info.grouping_type.trim() +
            '/' +
            sample_group_info.grouping_type_parameter;
          html += "<td class='stbl_" + sample_group_name.replace('/', '_') + "'>";
          if (sample_group_info.description) {
            html += generateBoxTable(
              sample_group_info.description,
              ['data', 'description_length', 'grouping_type'],
              undefined,
              true,
            );
          }
          html += '</td>';
        }
      }
    }
    if (trak.mdia.minf.stbl.subs || trak.has_fragment_subsamples) {
      html += "<td class='stbl_subsamples'>";
      if (sample.subsamples) {
        for (j = 0; j < sample.subsamples.length; j++) {
          html += generateBoxTable(sample.subsamples[j], [], [], true);
        }
      }
      html += '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody>';
  html += '</table>';
  $('#sampletable').html(html);
}

function buildSegmentTable(sidx, boxes, isofile, startSeg, endSeg) {
  var i, j, segment, prop, time, offset, moof;
  if (!sidx || !sidx.references || sidx.references.length === 0) return;
  var html = '';
  html += '<table>';
  html += '<thead>';
  html += '<tr>';
  segment = sidx.references[0];
  html += '<td>Segment Number</td>';
  for (prop in segment) {
    html += '<td>' + prop + '</td>';
  }
  html += '<td>' + 'segment start' + '</td>';
  html += '<td>' + 'segment offset' + '</td>';
  html += '<td>' + 'tfdt baseMediaDecodeTime' + '</td>';
  html += '<td>' + 'is encrypted' + '</td>';
  html += '</tr>';
  html += '</thead>';
  html += '<tbody>';
  time = 0;
  j = 0;
  offset = sidx.start + sidx.size + sidx.first_offset;
  moof = null;
  for (i = 0; i < sidx.references.length; i++) {
    segment = sidx.references[i];
    if (i >= startSeg && i < endSeg) {
      html += '<tr>';
      html += '<td>' + i + '</td>';
      for (prop in segment) {
        html += '<td>' + segment[prop];
        if (prop == 'subsegment_duration' || prop == 'SAP_delta_time') {
          html += ' - ' + Log.getDurationString(segment[prop], sidx.timescale);
        }
        html += '</td>';
      }
      html += '<td>' + time + ' - ' + Log.getDurationString(time, sidx.timescale) + '</td>';
      while (j < boxes.length) {
        if (boxes[j].start === offset) {
          while (j < boxes.length) {
            if (boxes[j].type === 'moof') {
              moof = boxes[j];
              break;
            } else {
              j++;
            }
          }
          break;
        } else {
          j++;
        }
      }
      html += '<td>' + offset + '</td>';
      if (moof && moof.trafs && moof.trafs[0] && moof.trafs[0].tfdt) {
        var trak = isofile.getTrackById(moof.trafs[0].tfhd.track_id);
        var trak_timescale = trak.mdia.mdhd.timescale;
        html +=
          '<td>' +
          moof.trafs[0].tfdt.baseMediaDecodeTime +
          ' - ' +
          Log.getDurationString(moof.trafs[0].tfdt.baseMediaDecodeTime, trak_timescale) +
          '</td>';
      }
      if (moof && moof.trafs && moof.trafs[0]) {
        html += '<td>' + (moof.trafs[0].senc ? true : false) + '</td>';
      }
      html += '</tr>';
    }
    time += segment.subsegment_duration;
    offset += segment.referenced_size;
    moof = null;
  }

  html += '</tbody>';
  html += '</table>';
  $('#segmenttable').html(html);
}

function buildSegmentGraph(sidx, startSeg, endSeg) {
  graph = new SegmentGraph();
  graph.data = [];
  var time = 0;
  if (!sidx || !sidx.references || sidx.references.length === 0) return;
  for (var i = 0; i < sidx.references.length; i++) {
    graph.data[i] = {};
    graph.data[i].number = i;
    graph.data[i].time = time;
    graph.data[i].size = sidx.references[i].referenced_size;
    graph.data[i].duration = sidx.references[i].subsegment_duration;
    time += sidx.references[i].subsegment_duration;
  }
  graph.data = graph.data.slice(startSeg, endSeg);
  graph.update();
}

function resetSegmentView() {
  $('#segmenttable').html('');
  $('#segment-range-value').val('');
  $('#segmentgraph').html('');
}

function buildSegmentView(fileobj) {
  var segmentRangeSlider = $('#segment-range');
  var segmenteRangeText = $('#segment-range-value');
  segmenteRangeText.addClass('ui-widget ui-widget-content ui-corner-all');
  var startSeg = 0;
  var endSeg = 10;
  var sidx = fileobj.mp4boxfile.sidx;
  if (!sidx || !sidx.references || sidx.references.length === 0) return;
  var nbSeg = sidx.references.length;
  segmentRangeSlider.dragslider({
    range: true,
    rangeDrag: true,
    min: 0,
    step: 0.01,
    max: 100,
    values: [startSeg / nbSeg, endSeg / nbSeg],
    slide: function (event, ui) {
      startSeg = Math.floor((ui.values[0] * nbSeg) / 100);
      endSeg = Math.floor((ui.values[1] * nbSeg) / 100);

      segmenteRangeText.val('' + startSeg + ' - ' + endSeg + '/' + nbSeg);

      if ($('#segmenttable').is(':visible')) {
        buildSegmentTable(
          fileobj.mp4boxfile.sidx,
          fileobj.mp4boxfile.boxes,
          fileobj.mp4boxfile,
          startSeg,
          endSeg,
        );
      }

      if ($('#segmentgraph').is(':visible')) {
        buildSegmentGraph(fileobj.mp4boxfile.sidx, startSeg, endSeg);
      }
    },
  });

  segmenteRangeText.val('' + startSeg + ' - ' + endSeg + '/' + nbSeg);

  buildSegmentTable(sidx, fileobj.mp4boxfile.boxes, fileobj.mp4boxfile, startSeg, endSeg);

  buildSegmentGraph(sidx, startSeg, endSeg);
}

function buildEntityGroupTable(entity_groups) {
  var html;
  var i, j;
  html = '<table>';
  html += '<thead>';
  html += '<tr>';
  html += '<th>Entity Group ID</th>';
  html += '<th>Type</th>';
  html += '<th>Entities [item ID]</th>';
  html += '<th>Properties [type]</th>';
  html += '</tr>';
  html += '</thead>';
  html += '<tbody>';
  for (i in entity_groups) {
    var entity_group = entity_groups[i];
    html += '<td>' + entity_group.id + '</td>';
    html += '<td>' + entity_group.type + '</td>';
    html += '<td>' + entity_group.entity_ids.join() + '</td>';
    html += '<td>';
    if (entity_group.properties) {
      for (j = 0; j < entity_group.properties.boxes.length; j++) {
        html += '' + entity_group.properties.boxes[j].type + ' ';
      }
    }
    html += '</td>';
    html += '</tr>';
  }
  html += '</tbody>';
  html += '</table>';
  $('#entitygroupview').html(html);
}

window.onload = function () {
  createLoadBar($('#menubar'), 'File', 'file', file, finalizeAnalyzerUI);

  createFancyTree($('#boxtree'), file);

  $('#expandall').on('click', function () {
    // Same as fancytree.expandAll() which is unavailable in lib/fancytree.
    file.fancytree.visit(function (node) {
      if (node.hasChildren() !== false && !node.isExpanded()) {
        node.setExpanded(true, []);
      }
    });
  });
  $('#collapseall').on('click', function () {
    file.fancytree.visit(function (node) {
      if (node.hasChildren() !== false && node.isExpanded()) {
        node.setExpanded(false, []);
      }
    });
  });

  $('#resulttabs').tabs();
  $('#boxview').tabs();
  $('#sampleviewselector').selectmenu({
    width: 200,
    change: function (e) {
      switch (e.target.selectedOptions[0].value) {
        case 'Sample Table':
          $('#sampletable').show();
          $('#samplegraph').hide();
          $('#samplemap').hide();
          $('#sampletimeline').hide();
          break;
        case 'Sample Graph':
          $('#sampletable').hide();
          $('#samplegraph').show();
          $('#samplemap').hide();
          $('#sampletimeline').hide();
          break;
        case 'Sample Map':
          $('#sampletable').hide();
          $('#samplegraph').hide();
          $('#samplemap').show();
          $('#sampletimeline').hide();
          break;
        case 'Sample Timeline':
          $('#sampletable').hide();
          $('#samplegraph').hide();
          $('#samplemap').hide();
          $('#sampletimeline').show();
          break;
      }
    },
  });
  $('#sampletable').show();
  $('#samplegraph').hide();
  $('#samplemap').hide();
  $('#sampletimeline').hide();

  $('#segmentviewselector').selectmenu({
    width: 200,
    change: function (e) {
      switch (e.target.selectedOptions[0].value) {
        case 'Segment Table':
          $('#segmenttable').show();
          $('#segmentgraph').hide();
          break;
        case 'Segment Graph':
          $('#segmenttable').hide();
          $('#segmentgraph').show();
          break;
      }
    },
  });
  $('#segmenttable').show();
  $('#segmentgraph').hide();

  if (window.location.search) {
    file.objectToLoad = window.location.search.substring(1);
    httpload(
      file,
      $('#file_progressbar'),
      $('#file_progress-label'),
      $('#file_LoadButton'),
      finalizeAnalyzerUI,
    );
  }
};

function displayItemContent(id) {
  var string;
  var item = file.mp4boxfile.getItem(id);
  console.log('Item ' + id + ', content:');
  switch (item.content_type) {
    case 'text/plain':
    case 'text/html':
    case 'text/css':
    case 'application/ecmascript':
      string = new DataStream(item.data.buffer).readString(item.data.length);
      console.log(string);
      break;
    default:
      console.log('Cannot display binary data');
  }
  //file.mp4boxfile.releaseItem(id);
}

function createBoxTreeMapSVG(boxnodes) {
  d3.select('#boxmapview').html('');
  var selectDiv = d3.select('#boxmapview').append('div');
  selectDiv.append('span').text("Display D3's TreeMap of boxes based on the ");
  var select = selectDiv.append('select').attr('id', 'boxTreeMapSelect');
  select.append('option').attr('value', 'size').text('size');
  select.append('option').attr('value', 'count').text('number of children');
  selectDiv.append('span').text(' of the box');
  /* from zoomable tree map */
  /* http://mbostock.github.io/d3/talk/20111018/treemap.html */
  var w = 1280 - 80;
  var h = 800 - 180;
  var x = d3.scale.linear().range([0, w]);
  var y = d3.scale.linear().range([0, h]);
  var color = d3.scale.category20c();
  var root, node;

  var treemap = d3.layout.treemap().round(false).size([w, h]).sticky(true).value(size);

  var svg = d3
    .select('#boxmapview')
    .append('div')
    .attr('class', 'chart')
    .style('width', w + 'px')
    .style('height', h + 'px')
    .append('svg:svg')
    .attr('width', w)
    .attr('height', h)
    .append('svg:g')
    .attr('transform', 'translate(.5,.5)');

  node = root = boxnodes;

  var nodes = treemap.nodes(root).filter(function (d) {
    return !d.children;
  });

  var cell = svg
    .selectAll('g')
    .data(nodes)
    .enter()
    .append('svg:g')
    .attr('class', 'cell')
    .attr('transform', function (d) {
      return 'translate(' + d.x + ',' + d.y + ')';
    })
    .on('click', function (d) {
      return zoom(node == d.parent ? root : d.parent);
    });

  cell
    .append('svg:rect')
    .attr('width', function (d) {
      return d.dx > 1 ? d.dx - 1 : d.dx;
    })
    .attr('height', function (d) {
      return d.dy > 1 ? d.dy - 1 : d.dy;
    })
    .style('fill', function (d) {
      return color(d.parent.title);
    });

  cell
    .append('svg:text')
    .attr('x', function (d) {
      return d.dx / 2;
    })
    .attr('y', function (d) {
      return d.dy / 2;
    })
    .attr('dy', '.35em')
    .attr('text-anchor', 'middle')
    .text(function (d) {
      return d.title;
    })
    .style('opacity', function (d) {
      d.w = this.getComputedTextLength();
      return d.dx > d.w ? 1 : 0;
    });

  svg.on('click', function () {
    zoom(root);
  });

  d3.select('#boxTreeMapSelect').on('change', function () {
    treemap.value(this.value == 'size' ? size : count).nodes(root);
    zoom(node);
  });

  function size(d) {
    return d.size || d.data.box.size;
  }

  function count(d) {
    return 1;
  }

  function zoom(d) {
    var kx = w / d.dx,
      ky = h / d.dy;
    x.domain([d.x, d.x + d.dx]);
    y.domain([d.y, d.y + d.dy]);

    var t = svg
      .selectAll('g.cell')
      .transition()
      .duration(d3.event.altKey ? 7500 : 750)
      .attr('transform', function (d) {
        return 'translate(' + x(d.x) + ',' + y(d.y) + ')';
      });

    t.select('rect')
      .attr('width', function (d) {
        return kx * d.dx > 1 ? kx * d.dx - 1 : kx * d.dx;
      })
      .attr('height', function (d) {
        return ky * d.dy > 1 ? ky * d.dy - 1 : ky * d.dy;
      });

    t.select('text')
      .attr('x', function (d) {
        return (kx * d.dx) / 2;
      })
      .attr('y', function (d) {
        return (ky * d.dy) / 2;
      })
      .style('opacity', function (d) {
        return kx * d.dx > d.w ? 1 : 0;
      });

    node = d;
    d3.event.stopPropagation();
  }
}

function createBoxPartition(boxnodes) {
  d3.select('#boxpartitionview').html('');
  /* from Tree Partition example http://mbostock.github.io/d3/talk/20111018/partition.html */
  var selectDiv = d3.select('#boxpartitionview').append('div');
  selectDiv.append('span').text("Display D3's partition of boxes based on the ");
  var select = selectDiv.append('select').attr('id', 'partitionSelect');
  select.append('option').attr('value', 'size').text('size');
  select.append('option').attr('value', 'count').text('number of children');
  selectDiv.append('span').text(' of the box');

  var w = 1120,
    h = 600,
    x = d3.scale.linear().range([0, w]),
    y = d3.scale.linear().range([0, h]);

  var div = d3
    .select('#boxpartitionview')
    .append('div')
    .attr('class', 'chart')
    .style('width', w + 'px')
    .style('height', h + 'px')
    .append('svg:svg')
    .attr('width', w)
    .attr('height', h);

  var partition = d3.layout.partition().value(size);

  var root, node;
  node = root = boxnodes;

  var g = div
    .selectAll('g')
    .data(partition.nodes(root))
    .enter()
    .append('svg:g')
    .attr('transform', function (d) {
      return 'translate(' + x(d.y) + ',' + y(d.x) + ')';
    })
    .on('click', click);

  var kx = w / root.dx,
    ky = h / 1;

  g.append('svg:rect')
    .attr('width', root.dy * kx)
    .attr('height', function (d) {
      return d.dx * ky;
    })
    .attr('class', function (d) {
      return d.children ? 'parent' : 'child';
    });

  g.append('svg:text')
    .attr('transform', transform)
    .attr('dy', '.35em')
    .style('opacity', function (d) {
      return d.dx * ky > 12 ? 1 : 0;
    })
    .text(function (d) {
      return d.title;
    });

  div.on('click', function () {
    click(root);
  });

  d3.select('#partitionSelect').on('change', function () {
    partition.value(this.value == 'size' ? size : count).nodes(root);
    click(root);
  });

  function size(d) {
    return d.size || d.data.box.size;
  }

  function count(d) {
    return 1;
  }

  function click(d) {
    if (!d.children) return;

    kx = (d.y ? w - 40 : w) / (1 - d.y);
    ky = h / d.dx;
    x.domain([d.y, 1]).range([d.y ? 40 : 0, w]);
    y.domain([d.x, d.x + d.dx]);

    var t = g
      .transition()
      .duration(d3.event.altKey ? 7500 : 750)
      .attr('transform', function (d) {
        return 'translate(' + x(d.y) + ',' + y(d.x) + ')';
      });

    t.select('rect')
      .attr('width', d.dy * kx)
      .attr('height', function (d) {
        return d.dx * ky;
      });

    t.select('text')
      .attr('transform', transform)
      .style('opacity', function (d) {
        return d.dx * ky > 12 ? 1 : 0;
      });

    node = d;

    d3.event.stopPropagation();
  }

  function transform(d) {
    return 'translate(8,' + (d.dx * ky) / 2 + ')';
  }
}

function getAllSamples(start, end) {
  var info = file.mp4boxfile.getInfo();
  var all = [];
  var samples, s;
  var i, j;

  for (i = 0; i < info.tracks.length; i++) {
    samples = file.mp4boxfile.getTrackSamplesInfo(info.tracks[i].id);
    for (j = start; j < (samples.length > end ? end : samples.length); j++) {
      s = samples[j];
      s.track = info.tracks[i].id;
      s.time = Math.floor((s.cts / s.timescale) * 1000);
      s.position = s.offset;
      all.push(s);
    }
  }
  return all.sort(function (a, b) {
    return a.position - b.position;
  });
}

function buildSampleMap(start, end) {
  d3.select('#samplemap').html('');
  var samples = getAllSamples(start, end);

  var color = d3.scale.category10();
  var w = 1120,
    h = 600,
    x = d3.scale.linear().range([0, w]),
    y = d3.scale.linear().range([0, h]);
  var nbLines = 40;
  var lineheight = h / nbLines;
  var ypos = 0;
  var xpos = 0;
  var scale = 0;
  var s;
  var remainingWidth = w;

  var svg = d3
    .select('#samplemap')
    .append('div')
    .attr('class', 'chart')
    .style('width', '100%')
    .append('svg:svg')
    .attr('viewBox', '0 0 ' + w + ' ' + h);

  for (i = 0; i < samples.length; i++) {
    s = samples[i];
    scale += s.size;
  }
  scale /= nbLines;
  scale /= w;

  function addSample(s, v) {
    var sample_tooltip = 'Sample Information:\n';
    /*for (var i in s) {
    		sample_tooltip += '  '+i+':\t'+s[i]+'\n';
    	}*/
    sample_tooltip += '  Track ID:\t' + s.track + '\n';
    sample_tooltip += '  Number:\t' + s.number + '\n';
    sample_tooltip += '  Size:\t\t' + s.size + '\n';
    sample_tooltip +=
      '  Duration:\t' + s.duration + ' (' + Log.getDurationString(s.duration, s.timescale) + ')\n';
    sample_tooltip +=
      '  CTS:\t\t' + s.cts + ' (' + Log.getDurationString(s.cts, s.timescale) + ')\n';
    sample_tooltip +=
      '  DTS:\t\t' + s.dts + ' (' + Log.getDurationString(s.dts, s.timescale) + ')\n';
    sample_tooltip += '  Sync:\t\t' + s.is_sync + '\n';
    sample_tooltip += '  Offset:\t\t' + s.position + '\n';
    svg
      .append('rect')
      .style('fill', color(s.track))
      .attr('x', xpos)
      .attr('y', ypos)
      .attr('height', lineheight)
      .attr('width', v)
      .append('title')
      .text(sample_tooltip);
    svg
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('x', xpos + v / 2)
      .attr('y', ypos + lineheight / 2)
      .text(s.time)
      .style('opacity', function (d) {
        var tw = this.getComputedTextLength();
        return v > tw ? 1 : 0;
      });
  }

  for (i = 0; i < samples.length; i++) {
    s = samples[i];
    rw = s.size / scale;
    while (rw > w - xpos) {
      addSample(s, w - xpos);
      rw -= w - xpos;
      xpos = 0;
      ypos += lineheight;
    }
    if (rw > 1) {
      addSample(s, rw);
      xpos += rw;
    }
  }
}

function verticalTimeline() {
  var data = this.data || [];
  var scale = data.length && data[0].duration ? 30 / data[0].duration : 30;
  const sample_width = 120;
  const content = this.svg.select('g.content');
  content.html('');
  var dts_offset = d3.min(data, function (d) {
    return Math.min(d.dts, d.cts);
  }) || 0;
  var timeline_end = d3.max(data, function (d) {
    return Math.max(d.dts, d.cts) + d.duration;
  }) || 0;
  var ypos = 50;
  this.height = ypos + (timeline_end - dts_offset) * scale;
  var width = this.width + this.margin.left + this.margin.right;
  var height = this.height + this.margin.top + this.margin.bottom;
  this.viewport.attr('height', height).attr('viewBox', '0 0 ' + width + ' ' + height);
  data.forEach(function (d, i) {
    var sampleg = content.append('g').attr("class","pair");
    const dts_y = (d.dts - dts_offset) * scale + ypos;
    const cts_y = (d.cts - dts_offset) * scale + ypos;
    const rect_h = d.duration * scale;
    const rect_middle =  rect_h / 2;
    // Decoding Timeline
    sampleg
      .append('rect')
      .attr('y', dts_y)
      .attr('width', sample_width)
      .attr('height',rect_h)
      .attr("class","block")
      .style('fill', 'red')
      .style('stroke', d.is_sync ? 'black' : 'none');
    sampleg
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('x', sample_width/ 2)
      .attr('y', dts_y + rect_middle )
      .text(d.dts);

    // Composition Timeline
    sampleg
      .append('rect')
      .attr('x', sample_width *2)
      .attr('y', cts_y)
      .attr('width', sample_width)
      .attr('height', rect_h)
      .attr("class","block")
      .style('fill', 'blue')
      .style('stroke', d.is_sync ? 'black' : 'none');
    sampleg
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('x', sample_width *2.5)
      .attr('y', cts_y + rect_middle)
      .text(d.cts);

    sampleg
      .append('line')
      .attr('x1', sample_width)
      .attr('y1', dts_y + rect_middle)
      .attr('x2', sample_width*2)
      .attr('y2', cts_y + rect_middle)
      .attr("class","block")
      .attr('stroke-width', '1px')
      .attr('marker-end', 'url(#arrow)')
      .style('stroke', 'black');
  });
};

SampleTimeline.prototype.update = verticalTimeline;

function SampleTimeline() {
  var margin = (this.margin = { top: 10, right: 10, bottom: 20, left: 20 });
  const sample_height = 30;
  const sample_width = 120;
  var width = (this.width = 3 * sample_width);
  var height = (this.height = 50);

  var div = d3.select('#sampletimeline');
  div.html('');
  this.viewport = div
    .append('svg')
    .attr('width', width + margin.left + margin.right)
    .attr('height', height + margin.top + margin.bottom)
    .style('max-width', '100%')
    .style('height', 'auto')
    .style('display', 'block')
    .attr(
      'viewBox',
      '0 0 ' + (width + margin.left + margin.right) + ' ' + (height + margin.top + margin.bottom),
    );
  this.svg = this.viewport
    .append('g')
    .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');
  this.svg
    .append('text')
    .attr('x', sample_width/2)
    .attr('y', sample_height/2)
    .attr('text-anchor', 'middle')
    .text('Decoding');
  this.svg
    .append('text')
    .attr('x', sample_width*2.5)
    .attr('y', sample_height/2)
    .attr('text-anchor', 'middle')
    .text('Composition');
  this.svg
    .append('defs')
    .append('marker')
    .attr('id', 'arrow')
    .attr('markerWidth', 13)
    .attr('markerHeight', 13)
    .attr('refX', 10)
    .attr('refY', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M2,2 L2,11 L10,6 z')
    .attr('fill', 'black');
  this.svg.append('g').attr("class","content");
}

SampleGraph.prototype.update = function () {
  var that = this;
  var data = this.data;
  if (!data || data.length === 0) {
    return;
  }
  var xaxisChoice = this.xaxisChoice;

  data.forEach(function (d, i) {
    d.x = xaxisChoice === 'time' ? d.cts : d.number;
    d.ctso = d.cts - d.dts;
  });

  this.x.domain(
    d3.extent(data, function (d) {
      return d.x;
    }),
  );

  this.svg.datum(data);
  this.svg
    .select('.x.axis')
    .attr('transform', 'translate(0,' + this.height + ')')
    .call(this.xAxis);

  this.svg.select('.x.axis text.label').text(this.xaxisChoice === 'time' ? 'CTS' : 'Number');

  for (i = 0; i < this.lines.length; i++) {
    l = this.lines[i];
    l.domain = [
      d3.min(data, function (d) {
        return d[l.name];
      }),
      d3.max(data, function (d) {
        return d[l.name];
      }),
    ];
    if (l.domain[0] === l.domain[1]) {
      l.domain[0]--;
      l.domain[1]++;
    }
    l.range.domain(l.domain);
    l.line = d3.svg
      .area()
      .interpolate('linear')
      .x(function (d) {
        return that.x(d.x);
      })
      .y(
        (function (ll) {
          return function (d) {
            return ll.range(d[l.name]);
          };
        })(l),
      );
    this.svg
      .select('.y.axis.' + l.name)
      .style('display', l.visible ? 'inline' : 'none')
      .call(l.axis);
    this.svg
      .select('path.' + l.name + 'line')
      .style('display', l.visible ? 'inline' : 'none')
      .attr('d', l.line);
  }
};

function SampleGraph() {
  var i, l;
  var that = this;

  var margin = { top: 10, right: 10, bottom: 80, left: 100 };
  var width = (this.width = document.body.clientWidth - margin.left - margin.right);
  var height = (this.height = window.innerHeight - margin.top - margin.bottom);

  function DrawableLine(name, color, legend, visible) {
    this.visible = visible;
    this.legend = legend;
    this.name = name;
    this.color = color;
    this.range = d3.scale.linear().range([height, 0]);
    this.axis = d3.svg
      .axis()
      .scale(this.range)
      .tickSize(1)
      .orient('left')
      .tickFormat(d3.format('d'));
  }

  var xaxisChoice = (this.xaxisChoice = 'number');
  this.lines = [
    new DrawableLine('dts', 'purple', 'DTS (timescale)', false),
    new DrawableLine('cts', 'black', 'CTS (timescale)', false),
    new DrawableLine('size', 'blue', 'Size (bytes)', true),
    new DrawableLine('ctso', 'red', 'CTS Offset (timescale)', false),
    new DrawableLine('duration', 'green', 'Duration (timescale)', false),
    new DrawableLine('is_sync', 'orange', 'RAP (boolean)', false),
  ];

  var div = d3.select('#samplegraph');
  div.html('');
  var form = div.append('form');
  form.append('span').text('X Axis: ');
  form
    .append('label')
    .text('Sample number')
    .append('input')
    .attr('type', 'radio')
    .attr('value', 'number')
    .attr('name', 'xaxis')
    .on('change', function () {
      that.xaxisChoice = 'number';
      that.update();
    });
  form
    .append('label')
    .text('Sample CTS')
    .append('input')
    .attr('type', 'radio')
    .attr('value', 'time')
    .attr('checked', 'checked')
    .attr('name', 'xaxis')
    .on('change', function () {
      that.xaxisChoice = 'time';
      that.update();
    });
  form.append('br');
  form.append('span').text('Y Axis: ');
  for (i = 0; i < this.lines.length; i++) {
    l = this.lines[i];
    var input = form.append('label').style('color', l.color).text(l.legend).append('input');
    form.append('span').text(' ');
    if (l.visible) {
      input.attr('checked', 'checked');
    }
    input
      .attr('type', 'checkbox')
      .attr('value', l.legend)
      .on(
        'change',
        (function (ll) {
          return function () {
            ll.visible = this.checked;
            that.update();
          };
        })(l),
      );
  }

  var svg = (this.svg = div
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr(
      'viewBox',
      '0 0 ' + (width + margin.left + margin.right) + ' ' + (height + margin.top + margin.bottom),
    )
    .append('g')
    .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')'));

  this.x = d3.scale.linear().range([0, width]);
  this.xAxis = d3.svg.axis().scale(this.x).orient('bottom').tickSize(1).tickFormat(d3.format('d'));

  /*var ctspoints = svg.selectAll(".point").data(data);
	ctspoints.attr("stroke", ctsLine.color)
			.attr("fill", function(d, i) { return ctsLine.color; })
			.attr("cx", function(d, i) { return x(d.x) })
			.attr("cy", function(d, i) { return ctsLine.range(d.cts) })
			.attr("r", function(d, i) { return 3 });
	ctspoints.enter().append("svg:circle")
			.attr("class","point")
			.attr("stroke", "black")
			.attr("fill", function(d, i) { return ctsLine.color; })
			.attr("cx", function(d, i) { return x(d.x) })
			.attr("cy", function(d, i) { return ctsLine.range(d.cts) })
			.attr("r", function(d, i) { return 3 });
	ctspoints.exit().remove();*/

  xaxislegend = svg
    .append('g')
    .attr('class', 'x axis')
    .attr('transform', 'translate(0,' + height + ')')
    .call(this.xAxis)
    .append('text')
    .attr('class', 'label')
    .attr('x', width - margin.right)
    .attr('y', 30)
    .style('text-anchor', 'end')
    .text(xaxisChoice === 'time' ? 'DTS' : 'Number');

  for (i = 0; i < this.lines.length; i++) {
    l = this.lines[i];
    svg
      .append('g')
      .attr('class', 'y axis ' + l.name)
      .style('display', l.visible ? 'inline' : 'none')
      .style('fill', l.color)
      .call(l.axis)
      .append('text')
      .attr('transform', 'rotate(-90)')
      .attr('y', 6)
      .attr('dy', '.71em')
      .style('text-anchor', 'end')
      .text(l.legend);
    svg
      .append('path')
      .attr('class', l.name + 'line')
      .style('display', l.visible ? 'inline' : 'none')
      .style('stroke', l.color);
  }
}

SegmentGraph.prototype.update = function () {
  var that = this;
  var data = this.data;
  if (!data || data.length === 0) {
    return;
  }
  var xaxisChoice = this.xaxisChoice;

  data.forEach(function (d, i) {
    d.x = xaxisChoice === 'time' ? d.time : d.number;
  });

  this.x.domain(
    d3.extent(data, function (d) {
      return d.x;
    }),
  );

  this.svg.datum(data);
  this.svg
    .select('.x.axis')
    .attr('transform', 'translate(0,' + this.height + ')')
    .call(this.xAxis);

  this.svg.select('.x.axis text.label').text(this.xaxisChoice === 'time' ? 'Time' : 'Number');

  for (i = 0; i < this.lines.length; i++) {
    l = this.lines[i];
    l.domain = [
      d3.min(data, function (d) {
        return d[l.name];
      }),
      d3.max(data, function (d) {
        return d[l.name];
      }),
    ];
    if (l.domain[0] === l.domain[1]) {
      l.domain[0]--;
      l.domain[1]++;
    }
    l.range.domain(l.domain);
    l.line = d3.svg
      .area()
      .interpolate('linear')
      .x(function (d) {
        return that.x(d.x);
      })
      .y(
        (function (ll) {
          return function (d) {
            return ll.range(d[l.name]);
          };
        })(l),
      );
    this.svg
      .select('.y.axis.' + l.name)
      .style('display', l.visible ? 'inline' : 'none')
      .call(l.axis);
    this.svg
      .select('path.' + l.name + 'line')
      .style('display', l.visible ? 'inline' : 'none')
      .attr('d', l.line);
  }
};

function SegmentGraph() {
  var i, l;
  var that = this;

  var margin = { top: 10, right: 10, bottom: 80, left: 100 };
  var width = (this.width = document.body.clientWidth - margin.left - margin.right);
  var height = (this.height = window.innerHeight - margin.top - margin.bottom);

  function DrawableLine(name, color, legend, visible) {
    this.visible = visible;
    this.legend = legend;
    this.name = name;
    this.color = color;
    this.range = d3.scale.linear().range([height, 0]);
    this.axis = d3.svg
      .axis()
      .scale(this.range)
      .tickSize(1)
      .orient('left')
      .tickFormat(d3.format('d'));
  }

  var xaxisChoice = (this.xaxisChoice = 'number');
  this.lines = [
    new DrawableLine('time', 'purple', 'Time (timescale)', false),
    new DrawableLine('size', 'blue', 'Size (bytes)', true),
    new DrawableLine('duration', 'green', 'Duration (timescale)', false),
    new DrawableLine('is_encrypted', 'orange', 'Encrypted (boolean)', false),
  ];

  var div = d3.select('#segmentgraph');
  div.html('');
  var form = div.append('form');
  form.append('span').text('X Axis: ');
  form
    .append('label')
    .text('Segment number')
    .append('input')
    .attr('type', 'radio')
    .attr('value', 'number')
    .attr('checked', 'checked')
    .attr('name', 'xaxis')
    .on('change', function () {
      that.xaxisChoice = 'number';
      that.update();
    });
  form
    .append('label')
    .text('Segment Time')
    .append('input')
    .attr('type', 'radio')
    .attr('value', 'time')
    .attr('name', 'xaxis')
    .on('change', function () {
      that.xaxisChoice = 'time';
      that.update();
    });
  form.append('br');
  form.append('span').text('Y Axis: ');
  for (i = 0; i < this.lines.length; i++) {
    l = this.lines[i];
    var input = form.append('label').style('color', l.color).text(l.legend).append('input');
    form.append('span').text(' ');
    if (l.visible) {
      input.attr('checked', 'checked');
    }
    input
      .attr('type', 'checkbox')
      .attr('value', l.legend)
      .on(
        'change',
        (function (ll) {
          return function () {
            ll.visible = this.checked;
            that.update();
          };
        })(l),
      );
  }

  var svg = (this.svg = div
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr(
      'viewBox',
      '0 0 ' + (width + margin.left + margin.right) + ' ' + (height + margin.top + margin.bottom),
    )
    .append('g')
    .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')'));

  this.x = d3.scale.linear().range([0, width]);
  this.xAxis = d3.svg.axis().scale(this.x).orient('bottom').tickSize(1).tickFormat(d3.format('d'));

  /*var ctspoints = svg.selectAll(".point").data(data);
	ctspoints.attr("stroke", ctsLine.color)
			.attr("fill", function(d, i) { return ctsLine.color; })
			.attr("cx", function(d, i) { return x(d.x) })
			.attr("cy", function(d, i) { return ctsLine.range(d.cts) })
			.attr("r", function(d, i) { return 3 });
	ctspoints.enter().append("svg:circle")
			.attr("class","point")
			.attr("stroke", "black")
			.attr("fill", function(d, i) { return ctsLine.color; })
			.attr("cx", function(d, i) { return x(d.x) })
			.attr("cy", function(d, i) { return ctsLine.range(d.cts) })
			.attr("r", function(d, i) { return 3 });
	ctspoints.exit().remove();*/

  xaxislegend = svg
    .append('g')
    .attr('class', 'x axis')
    .attr('transform', 'translate(0,' + height + ')')
    .call(this.xAxis)
    .append('text')
    .attr('class', 'label')
    .attr('x', width - margin.right)
    .attr('y', 30)
    .style('text-anchor', 'end')
    .text(xaxisChoice === 'time' ? 'Time' : 'Number');

  for (i = 0; i < this.lines.length; i++) {
    l = this.lines[i];
    svg
      .append('g')
      .attr('class', 'y axis ' + l.name)
      .style('display', l.visible ? 'inline' : 'none')
      .style('fill', l.color)
      .call(l.axis)
      .append('text')
      .attr('transform', 'rotate(-90)')
      .attr('y', 6)
      .attr('dy', '.71em')
      .style('text-anchor', 'end')
      .text(l.legend);
    svg
      .append('path')
      .attr('class', l.name + 'line')
      .style('display', l.visible ? 'inline' : 'none')
      .style('stroke', l.color);
  }
}
