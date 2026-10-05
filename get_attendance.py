from zk import ZK
import csv
from datetime import datetime

DEVICE_IP = '192.168.118.172'
DEVICE_PORT = 4370
COMM_KEY = 0

def main():
    zk = ZK(DEVICE_IP, port=DEVICE_PORT, password=COMM_KEY)

    print(f"Conectando al dispositivo {DEVICE_IP}:{DEVICE_PORT}...")
    try:
        conn = zk.connect()
        print("Conexion exitosa.")

        print("Obteniendo usuarios...")
        users = zk.get_users()
        user_map = {u.user_id: u.name for u in users}

        print("Obteniendo registros de asistencia...")
        attendances = zk.get_attendance()

        if not attendances:
            print("No se encontraron registros de asistencia.")
            return

        filename = f"asistencia_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"

        with open(filename, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['Usuario', 'Nombre', 'Fecha/Hora', 'Tipo', 'Verificacion'])

            for att in attendances:
                tipo = 'Entrada' if att.punch == 0 else 'Salida'
                nombre = user_map.get(str(att.user_id), 'Desconocido')
                writer.writerow([
                    att.user_id,
                    nombre,
                    att.timestamp.strftime('%Y-%m-%d %H:%M:%S'),
                    tipo,
                    att.verified
                ])

        print(f"Reporte guardado en: {filename}")
        print(f"Total registros: {len(attendances)}")

    except Exception as e:
        print(f"Error: {e}")
    finally:
        try:
            zk.disconnect()
            print("Desconectado del dispositivo.")
        except:
            pass

if __name__ == '__main__':
    main()
