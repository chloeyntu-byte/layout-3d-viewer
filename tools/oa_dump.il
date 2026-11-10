; Read-only Virtuoso OA layout dump for the 3D viewer.
; Inputs are environment variables:
;   VL3D_LIB, VL3D_CELLS, VL3D_VIEW, VL3D_OUT_DIR, VL3D_MAX_DEPTH, VL3D_SHAPE_LIMIT
; Default hierarchy depth is intentionally larger than a simple device stack so
; exported top cells include nested PDK devices, MIM arrays, and via/contact cells.
; TSV v4 adds read-only device category evidence and actual technology via endpoints.
; TSV v3 added explicit terminal pins, hierarchical instance connections, labels,
; technology-library identity, and export-completeness metadata while keeping
; the stream easy to parse.

procedure(vl3dEnv(name fallback)
  let((value)
    value = getShellEnvVar(name)
    if(value == nil || value == "" then fallback else value)
  )
)

procedure(vl3dPointX(pt)
  car(pt)
)

procedure(vl3dPointY(pt)
  cadr(pt)
)

procedure(vl3dBBoxString(bb)
  if(bb then
    sprintf(nil "%L,%L,%L,%L"
      vl3dPointX(car(bb)) vl3dPointY(car(bb))
      vl3dPointX(cadr(bb)) vl3dPointY(cadr(bb)))
  else
    ""
  )
)

procedure(vl3dSafe(value fallback)
  if(value == nil then fallback else value)
)

procedure(vl3dTsvText(value fallback)
  let((text controls)
    text = vl3dSafe(value fallback)
    unless(stringp(text)
      text = sprintf(nil "%L" text)
    )
    controls = list(sprintf(nil "\t") sprintf(nil "\n") sprintf(nil "\r"))
    foreach(control controls
      while(rexMatchp(control text)
        text = rexReplace(text " " 0)
      )
    )
    text
  )
)

procedure(vl3dValidOaName(value)
  stringp(value) && rexMatchp("^[A-Za-z0-9_.$:+-]+$" value)
)

procedure(vl3dTechLibraryName(cv)
  let((libObject techFile techName)
    techName = ""
    when(cv
      libObject = ddGetObj(cv~>libName)
      when(libObject
        techFile = car(errset(techGetTechFile(libObject) nil))
        when(techFile
          techName = vl3dSafe(techFile~>libName "")
        )
      )
    )
    techName
  )
)

procedure(vl3dReserveRecord(kind)
  let((allowed)
    allowed = nil
    cond(
      ((vl3dRecordCount >= vl3dRecordLimit)
        vl3dTruncated = t
        vl3dStopWalk = t)
      ((kind == "shape" && vl3dShapeCount >= vl3dShapeLimit)
        vl3dTruncated = t
        vl3dStopWalk = t)
      ((kind == "instance" && vl3dInstanceCount >= vl3dInstanceLimit)
        vl3dTruncated = t
        vl3dStopWalk = t)
      ((kind == "pin" && vl3dPinCount >= vl3dPinLimit)
        vl3dTruncated = t
        vl3dStopWalk = t)
      ((kind == "connection" && vl3dConnectionCount >= vl3dConnectionLimit)
        vl3dTruncated = t
        vl3dStopWalk = t)
      (t
        vl3dRecordCount = vl3dRecordCount + 1
        allowed = t)
    )
    allowed
  )
)

procedure(vl3dShapeLayer(shape)
  let((layer lpp)
    layer = shape~>layerName
    lpp = shape~>lpp
    if(layer == nil && listp(lpp) then layer = car(lpp))
    vl3dSafe(layer "unknown")
  )
)

procedure(vl3dShapePurpose(shape)
  let((purpose lpp)
    purpose = shape~>purpose
    if(purpose == nil then purpose = shape~>purposeName)
    lpp = shape~>lpp
    if(purpose == nil && listp(lpp) then purpose = cadr(lpp))
    vl3dSafe(purpose "drawing")
  )
)

procedure(vl3dTransPoint(pt xform)
  if(xform then dbTransformPoint(pt xform) else pt)
)

procedure(vl3dTransBBox(bb xform)
  if(bb && xform then dbTransformBBox(bb xform) else bb)
)

procedure(vl3dPointsString(points xform)
  let((text first tpt)
    text = ""
    first = t
    foreach(pt points
      tpt = vl3dTransPoint(pt xform)
      if(first then
        first = nil
      else
        text = strcat(text ";")
      )
      text = strcat(text sprintf(nil "%L,%L" vl3dPointX(tpt) vl3dPointY(tpt)))
    )
    text
  )
)

procedure(vl3dRectPointsFromBBox(bb)
  if(bb then
    list(
      car(bb)
      list(vl3dPointX(cadr(bb)) vl3dPointY(car(bb)))
      cadr(bb)
      list(vl3dPointX(car(bb)) vl3dPointY(cadr(bb)))
    )
  else
    nil
  )
)

procedure(vl3dShapePoints(shape xform)
  let((objType points bb)
    objType = shape~>objType
    points = nil
    cond(
      ((equal objType "pathSeg")
        unless(shape~>boundary
          error("VL3D pathSeg has no exact OA boundary")
        )
        points = shape~>boundary)
      ((equal objType "rect")
        points = vl3dRectPointsFromBBox(shape~>bBox))
      ((shape~>points)
        points = shape~>points)
      ((shape~>bBox)
        points = vl3dRectPointsFromBBox(shape~>bBox))
    )
    if(points then vl3dPointsString(points xform) else "")
  )
)

procedure(vl3dShapeLabel(shape)
  let((label)
    label = ""
    when(member(shape~>objType list("label" "textDisplay"))
      label = shape~>theLabel
    )
    vl3dSafe(label "")
  )
)

procedure(vl3dEmitShape(out shape xform ownerCell path @optional inheritedNet)
  let((objType layer purpose width bbox points netName label sourceType sourceWidth scale pathStyle beginStyle endStyle beginExt endExt)
    vl3dShapeSeen = vl3dShapeSeen + 1
    if(vl3dReserveRecord("shape") then
      objType = vl3dSafe(shape~>objType "shape")
      layer = vl3dShapeLayer(shape)
      purpose = vl3dShapePurpose(shape)
      sourceType = objType
      scale = if(xform then abs(caddr(xform)) else 1.0)
      sourceWidth = vl3dSafe(shape~>width 0) * scale
      width = sourceWidth
      pathStyle = ""
      beginStyle = ""
      endStyle = ""
      beginExt = 0.0
      endExt = 0.0
      when(member(objType list("path" "pathSeg"))
        pathStyle = vl3dSafe(shape~>pathStyle "truncate")
        beginStyle = vl3dSafe(shape~>beginStyle pathStyle)
        endStyle = vl3dSafe(shape~>endStyle pathStyle)
        beginExt = vl3dSafe(shape~>beginExt 0) * scale
        endExt = vl3dSafe(shape~>endExt 0) * scale
        when(beginStyle == "extend" beginExt = sourceWidth / 2.0)
        when(endStyle == "extend" endExt = sourceWidth / 2.0)
      )
      when(objType == "pathSeg"
        objType = "polygon"
        width = 0.0
      )
      bbox = vl3dBBoxString(vl3dTransBBox(shape~>bBox xform))
      points = vl3dShapePoints(shape xform)
      netName = vl3dSafe(inheritedNet "")
      when(netName == "" && shape~>net
        netName = vl3dSafe(shape~>net~>name "")
      )
      label = vl3dShapeLabel(shape)
      fprintf(out "SHAPE\t%s\t%s\t%s\t%s\t%s\t%L\t%s\t%s\t%s\t%s\t%s\t%L\t%s\t%s\t%s\t%L\t%L\n"
        vl3dTsvText(ownerCell "unknown") vl3dTsvText(path "")
        vl3dTsvText(objType "shape") vl3dTsvText(layer "unknown")
        vl3dTsvText(purpose "drawing") width bbox points
        vl3dTsvText(netName "") vl3dTsvText(label "")
        vl3dTsvText(sourceType "") sourceWidth vl3dTsvText(pathStyle "")
        vl3dTsvText(beginStyle "") vl3dTsvText(endStyle "") beginExt endExt)
      vl3dShapeCount = vl3dShapeCount + 1
    )
  )
)

procedure(vl3dEmitPinFig(out fig xform ownerCell path terminalName pinName direction netName)
  prog((layer purpose bbox points)
    unless(vl3dReserveRecord("pin")
      return(nil)
    )
    layer = vl3dShapeLayer(fig)
    purpose = vl3dShapePurpose(fig)
    bbox = vl3dBBoxString(vl3dTransBBox(fig~>bBox xform))
    points = vl3dShapePoints(fig xform)
    fprintf(out "PIN\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n"
      vl3dTsvText(ownerCell "unknown") vl3dTsvText(path "")
      vl3dTsvText(terminalName "") vl3dTsvText(pinName "")
      vl3dTsvText(direction "unknown") vl3dTsvText(netName "")
      vl3dTsvText(layer "unknown") vl3dTsvText(purpose "pin") bbox points)
    vl3dPinCount = vl3dPinCount + 1
  )
)

procedure(vl3dEmitPins(out cv xform path)
  prog((terminalName pinName direction netName figs)
    foreach(term cv~>terminals
      when(vl3dStopWalk return(nil))
      terminalName = vl3dSafe(term~>name "")
      direction = vl3dSafe(term~>direction "unknown")
      netName = ""
      if(term~>net then netName = vl3dSafe(term~>net~>name ""))
      foreach(pin term~>pins
        pinName = terminalName
        figs = pin~>figs
        foreach(fig figs
          when(vl3dStopWalk return(nil))
          vl3dEmitPinFig(out fig xform cv~>cellName path
            terminalName pinName direction netName)
        )
      )
    )
  )
)

procedure(vl3dEmitInstance(out inst xform path)
  prog((master mlib mcell mview name bbox)
    unless(vl3dReserveRecord("instance")
      return(nil)
    )
    master = inst~>master
    name = vl3dSafe(inst~>name "inst")
    mlib = "unknown"
    mcell = "unknown"
    mview = "unknown"
    if(master then
      mlib = vl3dSafe(master~>libName "unknown")
      mcell = vl3dSafe(master~>cellName "unknown")
      mview = vl3dSafe(master~>viewName "unknown")
    )
    bbox = vl3dBBoxString(vl3dTransBBox(inst~>bBox xform))
    fprintf(out "INSTANCE\t%s\t%s\t%s\t%s\t%s\t%s\n"
      vl3dTsvText(path "") vl3dTsvText(name "inst")
      vl3dTsvText(mlib "unknown") vl3dTsvText(mcell "unknown")
      vl3dTsvText(mview "unknown") bbox)
    vl3dInstanceCount = vl3dInstanceCount + 1
  )
)

procedure(vl3dEmitConnections(out inst occurrencePath parentPath)
  prog((terminalName parentNet childFormalNet formalTerm)
    foreach(instTerm inst~>instTerms
      when(vl3dStopWalk return(nil))
      unless(vl3dReserveRecord("connection")
        return(nil)
      )
      formalTerm = instTerm~>term
      terminalName = vl3dSafe(instTerm~>name "")
      if(terminalName == "" && formalTerm then
        terminalName = vl3dSafe(formalTerm~>name "")
      )
      parentNet = ""
      if(instTerm~>net then parentNet = vl3dSafe(instTerm~>net~>name ""))
      childFormalNet = ""
      if(formalTerm && formalTerm~>net then
        childFormalNet = vl3dSafe(formalTerm~>net~>name "")
      )
      fprintf(out "CONNECTION\t%s\t%s\t%s\t%s\t%s\n"
        vl3dTsvText(occurrencePath "") vl3dTsvText(parentPath "")
        vl3dTsvText(parentNet "") vl3dTsvText(childFormalNet "")
        vl3dTsvText(terminalName ""))
      vl3dConnectionCount = vl3dConnectionCount + 1
    )
  )
)

 ; Category membership is PDK-authored device evidence. Never classify devices
; by their instance/cell spelling. Multiple incompatible categories stay unknown.
procedure(vl3dCategoryKind(name)
  let((key)
    key = lowerCase(name)
    cond(
      (member(key list("resistors" "rf_resistors")) "resistor")
      (member(key list("inductors" "rf_inductors")) "inductor")
      (member(key list("mosfets" "rf_mosfets")) "mos")
      (member(key list("capacitors" "rf_capacitors" "varactors")) "capacitor")
      ((key == "diodes") "diode")
      ((key == "bipolars") "bipolar")
      (t nil)
    )
  )
)

procedure(vl3dReadCategory(libObj category kind depth visited)
  prog((catObj members key entry)
    when(depth > 8 || member(category visited) return(nil))
    catObj = car(errset(ddCatOpen(libObj category "r") nil))
    when(catObj
      members = car(errset(ddCatGetCatMembers(catObj) nil))
      ddCatClose(catObj)
      foreach(item members
        cond(
          ((cadr(item) == "category")
            vl3dReadCategory(libObj car(item) kind depth + 1 cons(category visited)))
          ((cadr(item) == "cell")
            key = strcat(libObj~>name "/" car(item))
            entry = vl3dDeviceCategories[key]
            unless(member(kind entry)
              vl3dDeviceCategories[key] = cons(kind entry)
            ))
        )
      )
    )
  )
)

procedure(vl3dDeviceInfo(cv)
  prog((libObj kinds kind source pcell terminals baseCdf simInfo sim prefix prefixes)
    libObj = ddGetObj(cv~>libName)
    unless(member(cv~>libName vl3dCategoryLibraries)
      vl3dCategoryLibraries = cons(cv~>libName vl3dCategoryLibraries)
      foreach(category car(errset(ddCatGetLibCats(libObj) nil))
        kind = vl3dCategoryKind(category)
        when(kind vl3dReadCategory(libObj category kind 0 nil))
      )
    )
    kinds = vl3dDeviceCategories[strcat(cv~>libName "/" cv~>cellName)]
    pcell = if(cv~>superMaster then t else nil)
    terminals = length(cv~>terminals)
    kind = "module"
    source = "oa-cellview"
    cond(
      ((length(kinds) == 1)
        kind = car(kinds) source = "oa-library-category")
      ((length(kinds) > 1)
        kind = "unknown-device" source = "oa-category-conflict")
      (pcell
        kind = if(terminals >= 2 then "unknown-device" else "geometry")
        source = "oa-pcell-terminals"
        baseCdf = car(errset(cdfGetBaseCellCDF(ddGetObj(cv~>libName cv~>cellName)) nil))
        simInfo = if(baseCdf then baseCdf->simInfo else nil)
        foreach(simName list('auCdl 'auLvs 'spectre)
          sim = if(simInfo then get(simInfo simName) else nil)
          prefix = if(sim then sim->namePrefix else nil)
          when(member(prefix list("R" "L"))
            unless(member(prefix prefixes) prefixes = cons(prefix prefixes))
          )
        )
        when(length(prefixes) == 1
          kind = if(car(prefixes) == "R" then "resistor" else "inductor")
          source = "oa-cdf-primitive-prefix"
        )
        when(length(prefixes) > 1
          kind = "unknown-device" source = "oa-cdf-prefix-conflict"
        ))
    )
    return(list(kind source pcell terminals))
  )
)

procedure(vl3dEmitViaDefinitions(out cv)
  prog((tf libObj techName key cut lower upper)
    libObj = ddGetObj(cv~>libName)
    tf = car(errset(techGetTechFile(libObj) nil))
    when(tf
      techName = vl3dSafe(tf~>libName "")
      unless(member(techName vl3dViaTechKeys)
        vl3dViaTechKeys = cons(techName vl3dViaTechKeys)
        ; Technology material is authoritative even when layer names are unfamiliar.
        ; This metadata stays in the user's local export, never in built-in profiles.
        foreach(layer tf~>layers
          when(vl3dStopWalk return(nil))
          unless(vl3dReserveRecord("techlayer") return(nil))
          fprintf(out "TECHLAYER\t%s\t%s\t%s\n"
            vl3dTsvText(layer~>name "") vl3dTsvText(layer~>material "unknown")
            vl3dTsvText(techName ""))
        )
        foreach(def tf~>viaDefs
          when(vl3dStopWalk return(nil))
          when(def~>objType == "stdViaDef"
            cut = car(def~>params)
            lower = def~>layer1~>name
            upper = def~>layer2~>name
            when(stringp(cut) && stringp(lower) && stringp(upper)
              key = strcat(techName "/" cut "/" lower "/" upper)
              unless(member(key vl3dViaDefKeys)
                unless(vl3dReserveRecord("viadef") return(nil))
                vl3dViaDefKeys = cons(key vl3dViaDefKeys)
                fprintf(out "VIADEF\t%s\t%s\t%s\t%s\t%s\n"
                  vl3dTsvText(cut "") vl3dTsvText(lower "") vl3dTsvText(upper "")
                  vl3dTsvText(techName "") vl3dTsvText(def~>name ""))
              )
            )
          )
        )
      )
    )
  )
)

procedure(vl3dEmitSource(out cv)
  prog((key libName cellName viewName deviceInfo)
    libName = vl3dSafe(cv~>libName "unknown")
    cellName = vl3dSafe(cv~>cellName "unknown")
    viewName = vl3dSafe(cv~>viewName "unknown")
    key = strcat(libName "/" cellName "/" viewName)
    unless(member(key vl3dSourceKeys)
      unless(vl3dReserveRecord("source")
        return(nil)
      )
      vl3dSourceKeys = cons(key vl3dSourceKeys)
      deviceInfo = vl3dDeviceInfo(cv)
      fprintf(out "SOURCE\t%s\t%s\t%s\t%s\t%s\t%L\t%L\n"
        vl3dTsvText(libName "unknown") vl3dTsvText(cellName "unknown")
        vl3dTsvText(viewName "unknown")
        car(deviceInfo) cadr(deviceInfo) caddr(deviceInfo) cadddr(deviceInfo))
      vl3dEmitViaDefinitions(out cv)
    )
  )
)

procedure(vl3dConcatTransform(instXform parentXform)
  if(parentXform then
    dbConcatTransform(instXform parentXform)
  else
    instXform
  )
)

; Native OA vias live in cv~>vias, not cv~>shapes or cv~>instances.
; Export the generated master figures (cuts AND enclosures), using the via's
; real origin/orientation and parent net. Never replace a cut array with its
; enclosing bbox. Keep geometry in its owning module's scope, without adding
; an artificial hierarchy node per via/cut. All shapes share existing limits.
procedure(vl3dEmitViaMaster(out master xform ownerCell path netName depth)
  prog(()
    when(depth > 16
      error("VL3D native via master hierarchy exceeds 16 levels")
    )
    foreach(shape master~>shapes
      when(vl3dStopWalk return(nil))
      vl3dEmitShape(out shape xform ownerCell path netName)
    )
    foreach(inst master~>instances
      when(vl3dStopWalk return(nil))
      when(inst~>master
        vl3dEmitViaMaster(out inst~>master
          vl3dConcatTransform(inst~>transform xform)
          ownerCell path netName depth + 1)
      )
    )
    foreach(via master~>vias
      when(vl3dStopWalk return(nil))
      vl3dEmitNativeVia(out via xform ownerCell path netName depth + 1)
    )
  )
)

procedure(vl3dEmitNativeVia(out via xform ownerCell path inheritedNet depth)
  let((header master viaXform netName)
    header = via~>viaHeader
    master = if(header then header~>master else nil)
    unless(master
      error("VL3D native via in %s has no readable generated master geometry" path)
    )
    netName = vl3dSafe(inheritedNet "")
    when(netName == "" && via~>net
      netName = vl3dSafe(via~>net~>name "")
    )
    viaXform = vl3dConcatTransform(
      list(via~>origin via~>orient 1.0) xform)
    vl3dEmitViaMaster(out master viaXform ownerCell path netName depth)
  )
)

procedure(vl3dWalkCv(out cv xform depth maxDepth path)
  prog((inst childXform childPath)
    when(vl3dStopWalk return(nil))
    vl3dEmitSource(out cv)
    when(vl3dStopWalk return(nil))
    when(depth > vl3dMaxDepthReached
      vl3dMaxDepthReached = depth
    )
    foreach(shape cv~>shapes
      when(vl3dStopWalk return(nil))
      vl3dEmitShape(out shape xform cv~>cellName path)
    )
    foreach(via cv~>vias
      when(vl3dStopWalk return(nil))
      vl3dEmitNativeVia(out via xform cv~>cellName path "" 0)
    )
    when(vl3dStopWalk return(nil))
    vl3dEmitPins(out cv xform path)
    when(vl3dStopWalk return(nil))
    foreach(inst cv~>instances
      when(vl3dStopWalk return(nil))
      childPath = strcat(path "/" vl3dTsvText(inst~>name "inst"))
      vl3dEmitInstance(out inst xform childPath)
      when(vl3dStopWalk return(nil))
      vl3dEmitConnections(out inst childPath path)
      when(vl3dStopWalk return(nil))
      when(inst~>master
        if(depth < maxDepth then
          childXform = vl3dConcatTransform(inst~>transform xform)
          vl3dWalkCv(out inst~>master childXform depth + 1 maxDepth childPath)
          when(vl3dStopWalk return(nil))
        else
          vl3dDepthLimited = t
        )
      )
    )
  )
)

procedure(vl3dExportCell(libName cellName viewName outDir maxDepth)
  let((cv out path dbu bbox safeLib safeCell safeView techLibName)
    unless(vl3dValidOaName(libName) && vl3dValidOaName(cellName) && vl3dValidOaName(viewName)
      error("VL3D unsafe OA identity")
    )
    safeLib = vl3dTsvText(libName "unknown")
    safeCell = vl3dTsvText(cellName "unknown")
    safeView = vl3dTsvText(viewName "unknown")
    printf("VL3D exporting %s/%s/%s\n" libName cellName viewName)
    cv = dbOpenCellViewByType(libName cellName viewName "" "r")
    if(cv == nil then
      error("VL3D could not open %s/%s/%s read-only" libName cellName viewName)
    )
    path = strcat(outDir "/" safeLib "@" safeCell "@" safeView ".tsv")
    out = outfile(path)
    if(out == nil then
      error("VL3D could not write %s" path)
    )
    dbu = vl3dSafe(cv~>DBUPerUU 1000)
    bbox = vl3dBBoxString(cv~>bBox)
    techLibName = vl3dTechLibraryName(cv)
    fprintf(out "# vl3d_layout_tsv_v4\n")
    fprintf(out "SCHEMA\t4\n")
    fprintf(out "CELL\t%s\t%s\t%s\t%L\t%s\n" safeLib safeCell safeView dbu bbox)
    fprintf(out "TECH\t%s\n" vl3dTsvText(techLibName ""))
    vl3dShapeSeen = 0
    vl3dShapeCount = 0
    vl3dInstanceCount = 0
    vl3dPinCount = 0
    vl3dConnectionCount = 0
    vl3dRecordCount = 0
    vl3dSourceKeys = nil
    vl3dViaTechKeys = nil
    vl3dViaDefKeys = nil
    vl3dCategoryLibraries = nil
    vl3dDeviceCategories = makeTable('vl3dDeviceCategories nil)
    vl3dTruncated = nil
    vl3dDepthLimited = nil
    vl3dStopWalk = nil
    vl3dMaxDepthReached = 0
    vl3dWalkCv(out cv nil 0 maxDepth safeCell)
    fprintf(out "STATUS\t%L\t%L\t%L\t%L\t%L\t%L\t%L\t%L\t%L\t%L\n"
      vl3dShapeSeen vl3dShapeCount vl3dTruncated vl3dMaxDepthReached
      maxDepth vl3dDepthLimited vl3dPinCount vl3dConnectionCount
      vl3dInstanceCount vl3dRecordCount)
    fprintf(out "ENDCELL\t%s\t%s\t%s\t%L\n" safeLib safeCell safeView vl3dShapeCount)
    close(out)
    dbClose(cv)
    printf("VL3D wrote %s with %L shapes\n" path vl3dShapeCount)
  )
)

procedure(vl3dMain()
  let((libName cellCsv viewName outDir maxDepthStr limitStr maxDepth cells)
    libName = vl3dEnv("VL3D_LIB" "")
    cellCsv = vl3dEnv("VL3D_CELLS" "TOP")
    viewName = vl3dEnv("VL3D_VIEW" "layout")
    outDir = vl3dEnv("VL3D_OUT_DIR" ".")
    maxDepthStr = vl3dEnv("VL3D_MAX_DEPTH" "8")
    limitStr = vl3dEnv("VL3D_SHAPE_LIMIT" "200000")
    maxDepth = atoi(maxDepthStr)
    vl3dShapeLimit = atoi(limitStr)
    vl3dInstanceLimit = atoi(vl3dEnv("VL3D_INSTANCE_LIMIT" "200000"))
    vl3dPinLimit = atoi(vl3dEnv("VL3D_PIN_LIMIT" "200000"))
    vl3dConnectionLimit = atoi(vl3dEnv("VL3D_CONNECTION_LIMIT" "400000"))
    vl3dRecordLimit = atoi(vl3dEnv("VL3D_RECORD_LIMIT" "1000000"))
    cells = parseString(cellCsv ",")
    foreach(cellName cells
      vl3dExportCell(libName cellName viewName outDir maxDepth)
    )
    t
  )
)

if(errset(vl3dMain() t) then
  exit(0)
else
  exit(1)
)
