# Используем официальный образ Node.js
FROM node:20-slim

# Устанавливаем Python и необходимые зависимости
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv gcc python3-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Создаем рабочую директорию
WORKDIR /app

# Копируем файлы проекта
COPY package*.json ./
COPY requirements.txt ./

# Устанавливаем зависимости Node.js
RUN npm install

# Устанавливаем зависимости Python с принудительным обновлением
RUN pip3 install --no-cache-dir --upgrade --break-system-packages -r requirements.txt

# Копируем остальной код
COPY . .

# Открываем порт
EXPOSE 3000

# Запускаем сервер (который внутри себя запустит Python)
CMD ["node", "server.js"]
