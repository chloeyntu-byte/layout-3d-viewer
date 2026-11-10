"""KLayout (Ruby) macro used by the optional KLayout compatibility parser.

Kept as a string so the repository ships no standalone .rb file; import_stream_layout.py
writes it to a temporary file before invoking `klayout -b -r`.
"""

MACRO = r'''# frozen_string_literal: true

require "fileutils"
require "json"
require "time"
require "zlib"

PALETTE = [
  "#4dabf7", "#51cf66", "#ffd43b", "#f06595", "#b197fc", "#38d9a9",
  "#ff922b", "#66d9e8", "#e599f7", "#8ce99a", "#ffa8a8", "#74c0fc"
].freeze

def truthy?(value)
  %w[1 true yes on].include?(value.to_s.strip.downcase)
end

def required_global(value, name)
  text = value.to_s.strip
  raise "Missing required -rd #{name}=... argument" if text.empty?

  text
end

def compact_number(value)
  rounded = value.round(9)
  rounded.zero? ? 0.0 : rounded
end

def safe_segment(value)
  text = value.to_s.strip.gsub("/", "_")
  text.empty? ? "unnamed" : text
end

def hierarchy_depth(path)
  [path.to_s.split("/").length - 1, 0].max
end

def atomic_write(path, contents)
  FileUtils.mkdir_p(File.dirname(path))
  temporary = "#{path}.tmp-#{Process.pid}"
  File.open(temporary, "wb") { |handle| handle.write(contents) }
  File.rename(temporary, path)
ensure
  FileUtils.rm_f(temporary) if defined?(temporary) && temporary && File.exist?(temporary)
end

def atomic_write_gzip(path, contents)
  FileUtils.mkdir_p(File.dirname(path))
  temporary = "#{path}.tmp-#{Process.pid}"
  Zlib::GzipWriter.open(temporary, Zlib::BEST_SPEED) { |gzip| gzip.write(contents) }
  File.rename(temporary, path)
ensure
  FileUtils.rm_f(temporary) if defined?(temporary) && temporary && File.exist?(temporary)
end

def backup_file(path, stamp)
  return nil unless File.file?(path)

  backup = "#{path}.bak-#{stamp}"
  FileUtils.cp(path, backup)
  backup
end

class StreamLayoutImporter
  def initialize(layout, input_path, output_path, options)
    @layout = layout
    @input_path = input_path
    @output_path = output_path
    @library = options.fetch(:library)
    @top_name = options[:top]
    @max_depth = options.fetch(:max_depth)
    @max_shapes = options.fetch(:max_shapes)
    @layer_map = options.fetch(:layer_map)
    @technology = options.fetch(:technology)
    @manifest_path = options[:manifest]
    @manifest_mode = options.fetch(:manifest_mode)
    @manifest_prefix = options.fetch(:manifest_prefix)
    @force = options.fetch(:force)
    @backup = options.fetch(:backup)
    @timestamp = Time.now.utc
    @stamp = @timestamp.strftime("%Y%m%d-%H%M%S")

    @shapes = []
    @instances = []
    @layers_by_index = {}
    @layer_shape_counts = Hash.new(0)
    @source_shapes_seen = 0
    @unsupported_shapes = 0
    @cycles_skipped = 0
    @depth_limited = false
    @truncated = false
    @max_depth_reached = 0
    @instance_serials = Hash.new(0)
    @used_instance_names = Hash.new { |hash, key| hash[key] = Hash.new(0) }
  end

  def run
    select_top_cell
    validate_output
    prepare_layer_metadata
    root_path = safe_segment(@top_cell.name)
    traverse(@top_cell, root_path, RBA::ICplxTrans.new, 0, [])
    payload = build_payload(root_path)
    write_outputs(payload)
    payload
  end

  private

  def select_top_cell
    tops = @layout.top_cells.sort_by(&:name)
    raise "No top cell found in #{@input_path}" if tops.empty?

    if @top_name && !@top_name.empty?
      @top_cell = @layout.cell(@top_name)
      raise "Top cell #{@top_name.inspect} not found; available: #{tops.map(&:name).join(', ')}" unless @top_cell
    elsif tops.length == 1
      @top_cell = tops.first
    else
      raise "Multiple top cells found; pass --top. Available: #{tops.map(&:name).join(', ')}"
    end
  end

  def validate_output
    raise "Output must end in .json: #{@output_path}" unless @output_path.downcase.end_with?(".json")
    existing = [@output_path, "#{@output_path}.gz"].select { |path| File.exist?(path) }
    return if existing.empty? || @force

    raise "Output already exists; pass --force to replace it: #{existing.join(', ')}"
  end

  def prepare_layer_metadata
    used_names = Hash.new(0)
    @layout.layer_indexes.each do |layer_index|
      info = @layout.get_info(layer_index)
      next unless info.layer && info.datatype

      mapping = layer_mapping(info.layer, info.datatype)
      mapping_present = (mapping.is_a?(String) && !mapping.strip.empty?) ||
                        (mapping.is_a?(Hash) && !mapping.empty?)
      default_name = info.name.to_s.strip
      default_name = "L#{info.layer}_D#{info.datatype}" if default_name.empty?
      requested_name = mapping.is_a?(String) ? mapping : (mapping || {}).fetch("name", default_name)
      requested_name = requested_name.to_s.strip
      requested_name = default_name if requested_name.empty?
      used_names[requested_name] += 1
      unique_name = requested_name
      unique_name = "#{requested_name}__L#{info.layer}_D#{info.datatype}" if used_names[requested_name] > 1

      metadata = mapping.is_a?(Hash) ? mapping : {}
      ["routing", "defaultVisible"].each do |field|
        next unless metadata.key?(field)
        raise "Layer map #{info.layer}/#{info.datatype} #{field} must be boolean" unless [true, false].include?(metadata[field])
      end
      stack_index = metadata.key?("stackIndex") ? metadata["stackIndex"].to_f : info.layer.to_f + info.datatype.to_f / 1000.0
      semantic = metadata.fetch("semantic", metadata.fetch("kind", "unknown"))
      @layers_by_index[layer_index] = {
        "name" => unique_name,
        "layerNumber" => info.layer,
        "datatype" => info.datatype,
        "sourceName" => info.name.to_s,
        "purpose" => metadata.fetch("purpose", "drawing"),
        "color" => metadata.fetch("color", PALETTE[(info.layer * 17 + info.datatype) % PALETTE.length]),
        "kind" => metadata.fetch("kind", "stream"),
        "semantic" => semantic,
        "routing" => metadata.key?("routing") ? !!metadata["routing"] : false,
        "defaultVisible" => metadata.key?("defaultVisible") ? !!metadata["defaultVisible"] : false,
        "stackIndex" => stack_index,
        "stackIndexSource" => metadata.key?("stackIndex") ? "layer-map" : "stream-order",
        "thickness" => metadata.fetch("thickness", metadata.fetch("thicknessUm", 0.2)).to_f,
        "thicknessSource" => metadata.fetch("thicknessSource", (metadata.key?("thickness") || metadata.key?("thicknessUm")) ? "layer-map" : "stream-default"),
        "metadataSource" => mapping_present ? "layer-map" : "stream-default",
        "lowerLayer" => metadata["lowerLayer"],
        "upperLayer" => metadata["upperLayer"],
        "lowerLayers" => metadata.fetch("lowerLayers", []),
        "upperLayers" => metadata.fetch("upperLayers", []),
        "connectivitySource" => metadata.fetch("connectivitySource", "name-inference")
      }
      ["metal", "lowerMetal", "upperMetal", "zBottomUm", "zTopUm", "approximate"].each do |field|
        @layers_by_index[layer_index][field] = metadata[field] if metadata.key?(field)
      end
    end
  end

  def layer_mapping(layer_number, datatype)
    ["#{layer_number}/#{datatype}", "#{layer_number}:#{datatype}", layer_number.to_s].each do |key|
      return @layer_map[key] if @layer_map.key?(key)
    end
    nil
  end

  def traverse(cell, path, world_transform, depth, ancestry)
    return if @truncated

    @max_depth_reached = [@max_depth_reached, depth].max
    emit_cell_shapes(cell, path, world_transform)
    return if @truncated

    child_instances = cell.each_inst.to_a
    if depth >= @max_depth
      @depth_limited = true unless child_instances.empty?
      return
    end

    child_instances.each do |instance|
      break if @truncated

      master = @layout.cell(instance.cell_index)
      next unless master

      base_name = source_instance_name(instance)
      if base_name.empty?
        @instance_serials[path] += 1
        base_name = "I#{@instance_serials[path]}_#{safe_segment(master.name)}"
      end
      transforms = instance.cell_inst.each_cplx_trans.to_a
      transforms.each_with_index do |local_transform, element_index|
        break if @truncated

        element_name = transforms.length > 1 ? "#{base_name}[#{element_index}]" : base_name
        element_name = unique_instance_name(path, element_name)
        child_path = "#{path}/#{safe_segment(element_name)}"
        child_transform = world_transform * local_transform
        bbox = transformed_box_bbox(master.bbox, child_transform)
        @instances << {
          "id" => @instances.length,
          "hierPath" => child_path,
          "parentPath" => path,
          "name" => element_name,
          "master" => { "library" => @library, "cell" => master.name, "view" => "layout" },
          "bbox" => bbox,
          "arrayElementIndex" => transforms.length > 1 ? element_index : nil,
          "transform" => transform_record(child_transform)
        }.reject { |_key, value| value.nil? }

        if ancestry.include?(master.cell_index) || master.cell_index == cell.cell_index
          @cycles_skipped += 1
          next
        end
        traverse(master, child_path, child_transform, depth + 1, ancestry + [cell.cell_index])
      end
    end
  end

  def emit_cell_shapes(cell, path, world_transform)
    @layers_by_index.each do |layer_index, layer|
      cell.shapes(layer_index).each do |shape|
        return if @truncated

        @source_shapes_seen += 1
        records = shape_records(shape, cell.name, path, layer, world_transform)
        if records.empty?
          @unsupported_shapes += 1
          next
        end
        records.each do |record|
          if @max_shapes > 0 && @shapes.length >= @max_shapes
            @truncated = true
            return
          end
          record["id"] = @shapes.length
          @shapes << record
          @layer_shape_counts[layer["name"]] += 1
        end
      end
    end
  end

  def shape_records(shape, owner_cell, path, layer, world_transform)
    common = {
      "ownerCell" => owner_cell,
      "hierPath" => path,
      "layer" => layer["name"],
      "layerNumber" => layer["layerNumber"],
      "datatype" => layer["datatype"],
      "purpose" => layer.fetch("purpose", "drawing"),
      "net" => "",
      "label" => ""
    }

    if shape.is_box?
      polygon = RBA::Polygon.new(shape.box).transformed(world_transform)
      points = polygon_points(polygon)
      return [common.merge("type" => "box", "width" => 0.0, "bbox" => bbox_from_points(points), "points" => points)]
    end

    if shape.is_path?
      path_geometry = shape.path.transformed(world_transform)
      points = []
      path_geometry.each_point { |point| points << point_to_microns(point) }
      return [] if points.length < 2

      return [common.merge(
        "type" => "path",
        "width" => distance_to_microns(path_geometry.width),
        "beginExtension" => distance_to_microns(path_geometry.bgn_ext),
        "endExtension" => distance_to_microns(path_geometry.end_ext),
        "round" => path_geometry.is_round?,
        "bbox" => box_to_bbox(path_geometry.bbox),
        "points" => points
      )]
    end

    polygon = if shape.is_polygon?
                shape.polygon
              elsif shape.is_simple_polygon?
                RBA::Polygon.new(shape.simple_polygon)
              end
    return [] unless polygon

    parts = polygon.holes > 0 ? polygon.decompose_trapezoids : [polygon]
    parts.each_with_index.map do |part, part_index|
      transformed = part.transformed(world_transform)
      points = polygon_points(transformed)
      next if points.length < 3

      common.merge(
        "type" => "polygon",
        "sourcePart" => parts.length > 1 ? part_index : nil,
        "width" => 0.0,
        "bbox" => bbox_from_points(points),
        "points" => points
      ).reject { |_key, value| value.nil? }
    end.compact
  end

  def source_instance_name(instance)
    properties = instance.properties
    return "" unless properties.respond_to?(:each)

    candidates = []
    properties.each do |key, value|
      key_text = key.to_s.upcase
      next unless key_text =~ /(INST|INSTANCE|SNAME|NAME)/

      value_text = value.to_s.strip
      candidates << value_text unless value_text.empty?
    end
    return "" if candidates.empty?

    safe_segment(candidates.first.to_s)
  rescue StandardError
    ""
  end

  def unique_instance_name(parent, requested)
    name = safe_segment(requested)
    @used_instance_names[parent][name] += 1
    count = @used_instance_names[parent][name]
    count == 1 ? name : "#{name}##{count}"
  end

  def point_to_microns(point)
    [distance_to_microns(point.x), distance_to_microns(point.y)]
  end

  def distance_to_microns(value)
    compact_number(value.to_f * @layout.dbu)
  end

  def polygon_points(polygon)
    points = []
    polygon.each_point_hull { |point| points << point_to_microns(point) }
    points
  end

  def box_to_bbox(box)
    if box.nil? || box.empty?
      { "min" => [0.0, 0.0], "max" => [0.0, 0.0] }
    else
      {
        "min" => [distance_to_microns(box.left), distance_to_microns(box.bottom)],
        "max" => [distance_to_microns(box.right), distance_to_microns(box.top)]
      }
    end
  end

  def transformed_box_bbox(box, transform)
    return box_to_bbox(box) if box.nil? || box.empty?

    polygon = RBA::Polygon.new(box).transformed(transform)
    box_to_bbox(polygon.bbox)
  end

  def bbox_from_points(points)
    xs = points.map { |point| point[0] }
    ys = points.map { |point| point[1] }
    { "min" => [xs.min, ys.min], "max" => [xs.max, ys.max] }
  end

  def transform_record(transform)
    displacement = transform.disp
    {
      "angle" => compact_number(transform.angle.to_f),
      "magnification" => compact_number(transform.mag.to_f),
      "mirror" => !!transform.is_mirror?,
      "translation" => [distance_to_microns(displacement.x), distance_to_microns(displacement.y)]
    }
  end

  def source_format
    name = @input_path.downcase.sub(/\.gz\z/, "")
    return "GDSII" if name.end_with?(".gds") || name.end_with?(".gdsii")
    return "OASIS" if name.end_with?(".oas") || name.end_with?(".oasis")

    "STREAM"
  end

  def build_layers
    used = @layers_by_index.values.select { |layer| @layer_shape_counts[layer["name"]] > 0 }
    used.sort_by { |layer| [layer["stackIndex"], layer["layerNumber"], layer["datatype"]] }.each_with_index.map do |layer, index|
      display_stack_index = layer["stackIndexSource"] == "layer-map" ? layer["stackIndex"] : index
      layer.merge(
        "index" => index,
        "shapeCount" => @layer_shape_counts[layer["name"]],
        "connectorCount" => 0,
        "stackIndex" => display_stack_index,
        "z" => index,
        "height" => 0.35
      )
    end
  end

  def build_payload(root_path)
    root_bbox = transformed_box_bbox(@top_cell.bbox, RBA::ICplxTrans.new)
    shape_depths = @shapes.map { |shape| hierarchy_depth(shape["hierPath"]) }
    instance_depths = @instances.map { |instance| hierarchy_depth(instance["hierPath"]) }
    layers = build_layers
    unclassified_layers = layers.select { |layer| layer["metadataSource"] == "stream-default" }
                                .map { |layer| layer["name"] }.sort
    technology = @technology.dup
    technology["unclassifiedLayers"] = unclassified_layers
    technology["usedLayerCount"] = layers.length
    technology["mappedLayerCount"] = layers.length - unclassified_layers.length
    warnings = build_warnings(technology, unclassified_layers)
    status = {
      "sourceFormat" => source_format,
      "shapesSeen" => @source_shapes_seen,
      "shapesEmitted" => @shapes.length,
      "truncated" => @truncated,
      "maxDepthReached" => @max_depth_reached,
      "maxDepthRequested" => @max_depth,
      "depthLimited" => @depth_limited,
      "pinsEmitted" => 0,
      "connectionsEmitted" => 0,
      "unsupportedShapesSkipped" => @unsupported_shapes,
      "cyclesSkipped" => @cycles_skipped,
      "unclassifiedLayerCount" => unclassified_layers.length,
      "warningCount" => warnings.length
    }

    {
      "schemaVersion" => 2,
      "sourceSchemaVersion" => 2,
      "generatedAt" => @timestamp.iso8601(6),
      "sourceFormat" => source_format,
      "sourceFile" => File.basename(@input_path),
      "units" => "um",
      "technology" => technology,
      "warnings" => warnings,
      "library" => @library,
      "cell" => @top_cell.name,
      "view" => "layout",
      "rootPath" => root_path,
      "dbuPerMicron" => compact_number(1.0 / @layout.dbu),
      "sourceDbuMicrons" => compact_number(@layout.dbu),
      "bbox" => root_bbox,
      "sourceShapeCount" => @source_shapes_seen,
      "shapeCount" => @shapes.length,
      "instanceCount" => @instances.length,
      "pinCount" => 0,
      "connectionCount" => 0,
      "maxShapeDepth" => shape_depths.max || 0,
      "maxInstanceDepth" => instance_depths.max || 0,
      "ownerCellCount" => @shapes.map { |shape| shape["ownerCell"] }.uniq.length,
      "layers" => layers,
      "shapes" => @shapes,
      "instances" => @instances,
      "pins" => [],
      "connections" => [],
      "netlistStatus" => {
        "available" => false,
        "reason" => "GDSII/OASIS geometry streams do not contain OA net, terminal, or pin connectivity"
      },
      "exportStatus" => status
    }
  end

  def build_warnings(technology, unclassified_layers)
    descriptor = technology["layerMap"].is_a?(Hash) ? technology["layerMap"] : {}
    unless descriptor["provided"]
      return [{
        "code" => "stream-generic-geometry",
        "severity" => "warning",
        "message" => "No layer map supplied; layers use generic geometry without OA/PDK semantics"
      }]
    end
    return [] if unclassified_layers.empty?

    source = descriptor["sourceFile"].to_s
    preview = unclassified_layers.first(12).join(", ")
    suffix = unclassified_layers.length > 12 ? ", ..." : ""
    [{
      "code" => "stream-layer-map-partial",
      "severity" => "warning",
      "message" => "Layer map #{source} leaves #{unclassified_layers.length} used layers generic: #{preview}#{suffix}"
    }]
  end

  def write_outputs(payload)
    json = JSON.generate(payload) + "\n"
    backup_file(@output_path, @stamp) if @backup && File.exist?(@output_path)
    backup_file("#{@output_path}.gz", @stamp) if @backup && File.exist?("#{@output_path}.gz")
    atomic_write(@output_path, json)
    atomic_write_gzip("#{@output_path}.gz", json)
    update_manifest(payload) if @manifest_path && !@manifest_path.empty?
  end

  def manifest_entry(payload)
    prefix = @manifest_prefix.to_s.gsub(%r{\A/+|/+$}, "")
    relative_path = prefix.empty? ? File.basename(@output_path) : "#{prefix}/#{File.basename(@output_path)}"
    {
      "library" => payload["library"],
      "cell" => payload["cell"],
      "view" => payload["view"],
      "path" => relative_path,
      "sourceFormat" => payload["sourceFormat"],
      "shapeCount" => payload["shapeCount"],
      "sourceShapeCount" => payload["sourceShapeCount"],
      "instanceCount" => payload["instanceCount"],
      "pinCount" => 0,
      "connectionCount" => 0,
      "layerCount" => payload["layers"].length,
      "maxShapeDepth" => payload["maxShapeDepth"],
      "maxInstanceDepth" => payload["maxInstanceDepth"],
      "ownerCellCount" => payload["ownerCellCount"],
      "bbox" => payload["bbox"],
      "exportStatus" => payload["exportStatus"],
      "technology" => payload["technology"],
      "warnings" => payload["warnings"]
    }
  end

  def update_manifest(payload)
    manifest = if @manifest_mode == "merge" && File.file?(@manifest_path)
                 JSON.parse(File.read(@manifest_path))
               else
                 { "schemaVersion" => 2, "cells" => [] }
               end
    cells = manifest["cells"].is_a?(Array) ? manifest["cells"] : []
    entry = manifest_entry(payload)
    cells.reject! do |cell|
      [cell["library"], cell["cell"], cell["view"]] == [entry["library"], entry["cell"], entry["view"]]
    end
    cells << entry
    manifest["schemaVersion"] = 2
    manifest["generatedAt"] = @timestamp.iso8601(6)
    manifest["cells"] = cells.sort_by { |cell| [cell["library"].to_s, cell["cell"].to_s, cell["view"].to_s] }
    json = JSON.generate(manifest) + "\n"
    backup_file(@manifest_path, @stamp) if @backup && File.exist?(@manifest_path)
    backup_file("#{@manifest_path}.gz", @stamp) if @backup && File.exist?("#{@manifest_path}.gz")
    atomic_write(@manifest_path, json)
    atomic_write_gzip("#{@manifest_path}.gz", json)
  end
end

input_path = File.expand_path(required_global($vl3d_input, "vl3d_input"))
output_path = File.expand_path(required_global($vl3d_output, "vl3d_output"))
library = required_global($vl3d_library, "vl3d_library")
top_name = $vl3d_top.to_s.strip
top_name = nil if top_name.empty?
max_depth = ($vl3d_max_depth || "64").to_i
max_shapes = ($vl3d_max_shapes || "0").to_i
manifest_path = $vl3d_manifest.to_s.strip
manifest_path = manifest_path.empty? ? nil : File.expand_path(manifest_path)
manifest_mode = ($vl3d_manifest_mode || "merge").to_s
manifest_prefix = ($vl3d_manifest_prefix || "data").to_s
force = truthy?($vl3d_force)
backup = !($vl3d_backup.to_s.strip.downcase == "false")
layer_map_path = $vl3d_layer_map.to_s.strip
layer_map = layer_map_path.empty? ? {} : JSON.parse(File.read(File.expand_path(layer_map_path)))
technology_text = $vl3d_technology.to_s.strip
technology = technology_text.empty? ? {} : JSON.parse(technology_text)

raise "Input does not exist: #{input_path}" unless File.file?(input_path)
raise "--max-depth must be zero or greater" if max_depth < 0
raise "--max-shapes must be zero or greater" if max_shapes < 0
raise "--manifest-mode must be merge or replace" unless %w[merge replace].include?(manifest_mode)
raise "Layer map must contain a JSON object" unless layer_map.is_a?(Hash)
raise "Technology metadata must contain a JSON object" unless technology.is_a?(Hash)
if manifest_path
  output_paths = [output_path, "#{output_path}.gz"].map { |path| File.expand_path(path) }
  manifest_paths = [manifest_path, "#{manifest_path}.gz"].map { |path| File.expand_path(path) }
  raise "Manifest and output must not refer to the same JSON/gzip files" unless (output_paths & manifest_paths).empty?
end

layout = RBA::Layout.new
layout.read(input_path)
raise "Invalid layout DBU #{layout.dbu.inspect}" unless layout.dbu.to_f > 0

importer = StreamLayoutImporter.new(layout, input_path, output_path, {
  library: library,
  top: top_name,
  max_depth: max_depth,
  max_shapes: max_shapes,
  layer_map: layer_map,
  technology: technology,
  manifest: manifest_path,
  manifest_mode: manifest_mode,
  manifest_prefix: manifest_prefix,
  force: force,
  backup: backup
})
payload = importer.run
puts "VL3D_IMPORT_OK output=#{output_path} shapes=#{payload['shapeCount']} instances=#{payload['instanceCount']}"
'''
