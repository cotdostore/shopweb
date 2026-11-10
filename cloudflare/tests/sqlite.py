import sys, json, sqlite3
request = json.load(sys.stdin)
db = sqlite3.connect(request['database'])
db.row_factory = sqlite3.Row
db.execute('PRAGMA foreign_keys=ON')
try:
    output = []
    with db:
        if request.get('schema'):
            db.executescript(request['schema'])
        for statement in request.get('statements', []):
            cursor = db.execute(statement['sql'], statement.get('params', []))
            rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
            output.append({'success': True, 'results': rows})
    print(json.dumps(output))
finally:
    db.close()
