import copy
import gzip
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0,os.path.join(ROOT,'tools'))
import annotate_pins as api


def source():
    return {'schemaVersion':2,'library':'SYNTHETIC','cell':'TOP','view':'layout','units':'um','dbuPerMicron':1000,
            'layers':[{'name':'M1','kind':'metal','routing':True}],
            'shapes':[{'id':91,'type':'rect','layer':'M1','hierPath':'TOP/A','bbox':{'min':[0,0],'max':[4,1]},'net':''}],
            'instances':[{'hierPath':'TOP/A','master':{'library':'SYNTHETIC','cell':'BLOCK','view':'layout'}},
                         {'hierPath':'TOP/B','master':{'library':'SYNTHETIC','cell':'BLOCK','view':'layout'}}],
            'pins':[{'id':7,'terminal':'Existing name','name':'Existing name','hierPath':'TOP','layer':'M1','worldBBox':{'min':[0,0],'max':[1,1]}}],
            'connections':[],'shapeCount':1,'pinCount':1,'instanceCount':2,'connectionCount':0,
            'deviceMetadataComplete':False}


def figure(path='TOP/A',**values):
    pin={'hierPath':path,'terminal':'A / β','name':' user pin 名称 ','layer':'M1','worldBBox':{'min':[.125,.25],'max':[.375,.75]}}
    pin.update(values);return pin


def sidecar(layout,pins=None):
    value=api.source_description(layout)[0];value['pins']=pins or [figure()];return value


class AnnotationTests(unittest.TestCase):
    def test_only_pins_and_annotation_metadata_change(self):
        original=source();before=copy.deepcopy(original);result=api.annotate(original,sidecar(original))
        self.assertEqual(original,before)
        for key,value in original.items():
            if key not in ('pins','pinCount'):self.assertEqual(result[key],value)
        self.assertEqual(result['pins'][0],original['pins'][0])
        pin=result['pins'][1]
        self.assertEqual(pin['name'],' user pin 名称 ')
        self.assertEqual(pin['terminal'],'A / β')
        self.assertEqual(pin['net'],'')
        self.assertEqual(pin['worldBBox'],figure()['worldBBox'])
        self.assertEqual(pin['points'],[[.125,.25],[.375,.25],[.375,.75],[.125,.75]])
        self.assertFalse(result['deviceMetadataComplete'])

    def test_hierarchy_and_multiple_figures_remain_distinct(self):
        src=source();pins=[figure(),figure(worldBBox={'min':[2,0],'max':[3,1]}),figure('TOP/B')]
        result=api.annotate(src,sidecar(src,pins))
        self.assertEqual([p['hierPath'] for p in result['pins'][1:]],['TOP/A','TOP/A','TOP/B'])
        self.assertEqual(len(set(p['id'] for p in result['pins'])),4)
        self.assertEqual([p['terminal'] for p in result['pins'][1:]],['A / β']*3)

    def test_source_identity_units_and_geometry_are_required(self):
        src=source()
        for change in ('identity','units','geometry'):
            card=sidecar(src)
            if change=='identity':card['source']['cell']='OTHER'
            if change=='units':card['units']='nm'
            if change=='geometry':card['source']['geometryDigest']='0'*64
            with self.assertRaises(api.AnnotationError):api.annotate(src,card)

    def test_viewer_units_are_validated_without_relabeling(self):
        for units in ('um', ' µm ', 'μm', 'UM'):
            src=source();src['units']=units;card=sidecar(src)
            result=api.annotate(src,card)
            self.assertEqual(result['units'],units)
            self.assertEqual(result['pins'][1]['worldBBox'],figure()['worldBBox'])
        for units in ('nm','dbu','',None):
            src=source();src['units']=units
            with self.assertRaises(api.AnnotationError):api.source_description(src)

    def test_generated_metadata_does_not_break_source_geometry_binding(self):
        src=source();card=sidecar(src);src['generatedAt']='later';src['source']={'sha256':'f'*64}
        src['layers'][0].update(color='#ffffff',metadataSource='layer-map')
        src['shapes'][0].update(width=0,semantic='metal',routing=True)
        self.assertEqual(api.annotate(src,card)['pinCount'],2)
        src['shapes'][0]['bbox']['max'][0]=5
        with self.assertRaises(api.AnnotationError):api.annotate(src,card)

    def test_invalid_path_layer_bbox_and_polygons_fail_without_repair(self):
        src=source()
        bad=[figure('TOP/Z'),figure(layer='MISSING'),figure(worldBBox={'min':[1,0],'max':[1,1]}),
             figure(points=[[0,0],[1,1],[0,1],[1,0]],worldBBox={'min':[0,0],'max':[1,1]}),
             figure(points=[[0,0],[1,0],[1,1]],worldBBox={'min':[0,0],'max':[2,2]}),
             figure(worldBBox={'min':[0,0],'max':[float('nan'),1]}),figure(id=7)]
        for pin in bad:
            with self.subTest(pin=pin):
                with self.assertRaises(api.AnnotationError):api.annotate(src,sidecar(src,[pin]))

    def test_polygon_coordinates_are_preserved(self):
        src=source();points=[[0,0],[3,0],[3,1],[1,1],[1,2],[0,2],[0,0]]
        pin=figure(points=points);pin.pop('worldBBox')
        result=api.annotate(src,sidecar(src,[pin]))['pins'][1]
        self.assertEqual(result['points'],points)
        self.assertEqual(result['worldBBox'],{'min':[0,0],'max':[3,2]})

    def test_cli_gzip_read_and_no_overwrite_or_source_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            raw=os.path.join(directory,'source.json.gz');card=os.path.join(directory,'pins.json');out=os.path.join(directory,'new.json')
            src=source()
            with gzip.open(raw,'wb') as handle:handle.write(json.dumps(src).encode())
            with open(card,'w') as handle:json.dump(sidecar(src),handle)
            before=hashlib.sha256(Path(raw).read_bytes()).hexdigest()
            cmd=[sys.executable,os.path.join(ROOT,'tools','annotate_pins.py'),raw,'--annotations',card,'--output',out]
            result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            self.assertEqual(result.returncode,0,result.stderr)
            contents=Path(out).read_bytes();again=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            self.assertNotEqual(again.returncode,0)
            self.assertEqual(Path(out).read_bytes(),contents)
            self.assertEqual(hashlib.sha256(Path(raw).read_bytes()).hexdigest(),before)
            os.unlink(out);os.symlink(raw,out)
            self.assertNotEqual(subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode,0)
            self.assertEqual(hashlib.sha256(Path(raw).read_bytes()).hexdigest(),before)

    def test_non_regular_input_fails_without_blocking(self):
        if not hasattr(os, 'mkfifo'):
            self.skipTest('FIFO unavailable')
        with tempfile.TemporaryDirectory() as directory:
            path=os.path.join(directory,'source.json');os.mkfifo(path)
            result=subprocess.run([sys.executable,os.path.join(ROOT,'tools','annotate_pins.py'),path,'--inspect'],
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=3)
            self.assertNotEqual(result.returncode,0)
            self.assertIn(b'regular file',result.stderr)

    def test_reapplying_same_sidecar_is_rejected(self):
        src=source();card=sidecar(src);annotated=api.annotate(src,card)
        with self.assertRaises(api.AnnotationError):api.annotate(annotated,card)

    def test_duplicate_json_keys_fail(self):
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as handle:
            handle.write('{"pins":[],"pins":[]}');handle.flush()
            with self.assertRaises(api.AnnotationError):api.read_json(handle.name,1024)


if __name__=='__main__':unittest.main()
